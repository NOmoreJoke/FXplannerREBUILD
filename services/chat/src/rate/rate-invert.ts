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

/** 上游报价文本白名单：trim 后非负十进制有限小数（禁科学计数法 / 符号；首尾空白容忍） */
const RAW_RATE_PATTERN = /^\d+(?:\.\d+)?$/;

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
 * @param raw 上游原始报价（string 优先；number 经 String 归一，JSON 短表示无精度引入）
 * @param base 报价基准币（审计/报错文案）
 * @param target 报价目标币（审计/报错文案）
 * @returns 固定 10 位小数的定点字符串（可直接落库 Decimal(20,10)）
 */
export function invertQuoteRate(
	raw: string | number,
	base: string,
	target: string,
): string {
	const text = String(raw).trim();
	if (!RAW_RATE_PATTERN.test(text)) {
		failInvalid(base, target);
	}

	const dotIndex = text.indexOf(".");
	const scale = dotIndex === -1 ? 0 : text.length - dotIndex - 1;
	const digits = BigInt(text.replace(".", ""));
	if (digits === 0n) {
		failInvalid(base, target);
	}

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
