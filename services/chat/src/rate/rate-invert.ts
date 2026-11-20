import { BadGatewayException } from "@nestjs/common";

/**
 * 跨源取倒数规则（MVP-F0-1 唯一口径，realtime-rate 底稿 §2「方向与精度」）。
 *
 * 冻结系统方向契约：RatePairQuote.rate 恒为「1 单位 target（quote）= X base」。
 * er-api / frankfurter 上游返回「1 base = raw target」，须在此精确取倒数；
 * ABC（百外币单位对 CNY 定点折算）与 identity 恒等价方向本就正确，不经过本函数。
 *
 * 精度规则：十进制定点（BigInt）求倒数 10^(s+10)/N，按 exchange_rates 表精度
 * Decimal(20,10) 做一次 HALF_UP，输出固定 10 位小数字符串（后续入账 8 位与
 * 本位币金额舍入由既有链路承担）；严禁 `1 / Number(raw)` 浮点路径。
 * 零 / 负 / 非法字符串 / 舍入归零 / 超出落库范围 → 源异常（502 语义）。
 */

/** 上游字符串报价白名单：trim 后非负十进制有限小数（禁科学计数法 / 符号） */
const RAW_RATE_PATTERN = /^\d+(?:\.\d+)?$/;
const JSON_RATE_PATTERN = /^(\d+(?:\.\d+)?)(?:[eE]([+-]?\d+))?$/;

/** exchange_rates.rate 表精度：Decimal(20,10) → 10 位小数、至多 10 位整数 */
const INVERTED_RATE_SCALE = 10;
const MAX_INTEGER_DIGITS = 10;

function failInvalid(base: string, target: string): never {
	throw new BadGatewayException(
		`汇率源返回了无效牌价: ${base} → ${target}`,
	);
}

function failRange(base: string, target: string, reason: string): never {
	throw new BadGatewayException(
		`汇率源牌价取倒数后${reason}: ${base} → ${target}`,
	);
}

/** 定点整数 → 固定 scale 位小数字符串（无浮点中转） */
function formatFixedPoint(value: bigint, scale: number): string {
	const text = value.toString().padStart(scale + 1, "0");
	const split = text.length - scale;
	return `${text.slice(0, split)}.${text.slice(split)}`;
}

/**
 * 「1 base = raw target」→「1 target = X base」：一次取倒数，HALF_UP 到 10 位小数。
 *
 * @param raw 上游字符串、已有 JS 数值，或从原始 JSON 提取的数字词元
 * @param base 报价基准币（审计/报错文案）
 * @param target 报价目标币（审计/报错文案）
 * @returns 固定 10 位小数的定点字符串（可直接落库 Decimal(20,10)）
 */
export function invertQuoteRate(
	raw: string | number | { numberToken: string },
	base: string,
	target: string,
): string {
	let coefficient: string;
	let exponent = 0;
	if (raw !== null && typeof raw === "object") {
		if (typeof raw.numberToken !== "string") failInvalid(base, target);
		const match = raw.numberToken.match(JSON_RATE_PATTERN);
		if (!match) failInvalid(base, target);
		coefficient = match[1];
		exponent = Number(match[2] ?? "0");
	} else {
		if (typeof raw !== "string" && typeof raw !== "number") failInvalid(base, target);
		coefficient = String(raw).trim();
		if (!RAW_RATE_PATTERN.test(coefficient)) failInvalid(base, target);
	}

	const dotIndex = coefficient.indexOf(".");
	const fractionLength = dotIndex === -1 ? 0 : coefficient.length - dotIndex - 1;
	const rawSignificant = coefficient.replace(".", "").replace(/^0+/, "");
	if (!rawSignificant) {
		failInvalid(base, target);
	}
	const significantDigits = rawSignificant.replace(/0+$/, "");
	const trailingZeros = rawSignificant.length - significantDigits.length;
	const scale = fractionLength - exponent - trailingZeros;

	// Reject exponents that put the reciprocal outside storage precision before
	// allocating powers of ten. Adjacent decades still need the exact HALF_UP check.
	if (scale < significantDigits.length - MAX_INTEGER_DIGITS - 1) {
		failRange(base, target, "舍入为 0");
	}
	if (scale >= significantDigits.length + MAX_INTEGER_DIGITS) {
		failRange(base, target, "超出落库范围");
	}
	const digits = BigInt(significantDigits);

	// 1/raw = 10^scale / digits；定标到 10 位小数后做一次 HALF_UP（全整数运算，无浮点）
	const numerator = 10n ** BigInt(scale + INVERTED_RATE_SCALE);
	const quotient = numerator / digits;
	const remainder = numerator % digits;
	const rounded = remainder * 2n >= digits ? quotient + 1n : quotient;

	if (rounded === 0n) {
		failRange(base, target, "舍入为 0");
	}
	if (rounded >= 10n ** BigInt(MAX_INTEGER_DIGITS + INVERTED_RATE_SCALE)) {
		failRange(base, target, "超出落库范围");
	}
	return formatFixedPoint(rounded, INVERTED_RATE_SCALE);
}
