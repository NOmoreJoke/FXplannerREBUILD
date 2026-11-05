import { BadGatewayException } from "@nestjs/common";
import { request as httpsRequest } from "node:https";
import {
	ABC_MIN_FETCH_INTERVAL_MS,
	ABC_RATE_TIMEOUT_MS,
	ABC_RATE_URL,
	RATE_CLOCK_SKEW_TOLERANCE_MS,
} from "./rate.constants";
import type {
	RateBatchQuote,
	RateHistoryPoint,
	RatePairQuote,
	RateSource,
} from "./rate-source";

/**
 * ABC 传输函数：GET url（超时 timeoutMs），成功 resolve 响应体文本，失败 reject。
 * 默认实现用 node:https + legacy TLS 重协商（实测 Node 全局 fetch/undici 会因
 * ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED 握手失败）；注入自定义实现便于测试 mock。
 */
export type AbcTransport = (url: string, timeoutMs: number) => Promise<string>;

interface AbcTableRow {
	CurrName?: string;
	BenchMarkPrice?: string;
	SellPrice?: string;
	PublishTime?: string;
}

interface AbcResponse {
	ErrorCode?: string;
	ErrorMsg?: string;
	Data?: { Table?: AbcTableRow[] };
}

/** 全表解析结果：有效行 + 无效行集合（涉及行命中无效集 → 源不可用） */
interface AbcTable {
	rows: Map<string, AbcTableEntry>;
	invalidCodes: Set<string>;
}

interface AbcTableEntry {
	/** 基准价（1 外币单位兑 X CNY；百外币单位已 ÷100），定点字符串 */
	rate: string;
	/** 现汇卖出价（仅 CNY base 场景提供；定点字符串） */
	sellRate?: string;
	observedAt: Date;
	/** 上游原始字符串（审计用） */
	raw: string;
}

/** 桌面浏览器 UA：农行接口拒绝无 UA 请求（实测任意桌面 UA + 通配 Accept 头即可） */
const ABC_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** SSL_OP_LEGACY_SERVER_CONNECT：农行 ewealth 网关使用旧式 TLS 重协商，须显式允许 */
const SSL_OP_LEGACY_SERVER_CONNECT = 0x0004;

/** 定点数：digits 为去小数点后的整数值，scale 为小数位数（671.055 → { 671055n, 3 }） */
interface FixedPoint {
	digits: bigint;
	scale: number;
}

/** CurrName 格式如 "美元(USD)" → 提取括号内三位货币代码 */
const CURR_CODE_PATTERN = /\(([A-Z]{3})\)/;

/** 解析有限小数字符串（拒绝空串/负数/科学计数法/非数字；脏类型先 ToString 防抛错） */
function parseFixedPoint(value: string | undefined): FixedPoint | undefined {
	if (value === undefined) return undefined;
	// String() 包裹 + String.prototype.match（非 global 正则语义等同 RegExp.exec；
	// 上游 JSON 脏类型（如数字）经 ToString 静默拒配而非抛 TypeError；静态扫描将
	// RegExp.prototype.exec 误读为 shell exec，见 docs/handoff/MIMOSA-GATE-20261105.md）
	const match = String(value).trim().match(/^(\d+)(?:\.(\d+))?$/);
	if (!match) return undefined;
	const [, integer, fraction = ""] = match;
	return { digits: BigInt(integer + fraction), scale: fraction.length };
}

/** 定点除法 a ÷ b，ROUND_HALF_UP 保留 outScale 位小数（零浮点，确定性与 Decimal 一致） */
function divideFixed(a: FixedPoint, b: FixedPoint, outScale: number): string {
	const numerator = a.digits * 10n ** BigInt(outScale + b.scale);
	const denominator = b.digits * 10n ** BigInt(a.scale);
	const quotient = numerator / denominator;
	const remainderTwice = (numerator % denominator) * 2n;
	const rounded =
		remainderTwice >= denominator ? quotient + 1n : quotient;
	const text = rounded.toString().padStart(outScale + 1, "0");
	return `${text.slice(0, -outScale)}.${text.slice(-outScale)}`;
}

/** 按源有效性规则解析价格：缺失/不可解析/≤0 → undefined（涉及行命中 → 源不可用） */
function parsePrice(value: string | undefined): FixedPoint | undefined {
	const parsed = parseFixedPoint(value);
	return parsed !== undefined && parsed.digits > 0n ? parsed : undefined;
}

/** 默认传输：node:https + legacy TLS；非 2xx / 网络错误 / 超时统一 reject（由调用方转 502） */
const defaultAbcTransport: AbcTransport = (url, timeoutMs) =>
	new Promise<string>((resolve, reject) => {
		const req = httpsRequest(
			url,
			{
				method: "GET",
				headers: { "User-Agent": ABC_USER_AGENT, Accept: "*/*" },
				secureOptions: SSL_OP_LEGACY_SERVER_CONNECT,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("error", (error) =>
					reject(new BadGatewayException(`ABC 汇率源响应失败: ${error.message}`)),
				);
				res.on("end", () => {
					const status = res.statusCode ?? 0;
					if (status < 200 || status >= 300) {
						reject(new BadGatewayException(`ABC 汇率源响应状态 ${status}`));
						return;
					}
					resolve(Buffer.concat(chunks).toString("utf8"));
				});
			},
		);
		const timer = setTimeout(() => {
			req.destroy(new Error(`ABC 请求超时（${timeoutMs}ms）`));
		}, timeoutMs);
		req.on("close", () => clearTimeout(timer));
		req.on("error", (error) =>
			reject(new BadGatewayException(`ABC 汇率源暂时不可用: ${error.message}`)),
		);
		req.end();
	});

export interface AbcSourceOptions {
	timeoutMs?: number;
	transport?: AbcTransport;
	minIntervalMs?: number;
	/** 时钟注入（测试 fake timers 用）；缺省 Date.now */
	now?: () => number;
}

/**
 * 主源：农业银行外汇牌价（一次全表、无认证、秒级 PublishTime、双价）。
 *
 * - 任意 base 折算：非 CNY base 用同一次全表响应内 X→CNY ÷ base→CNY（同一 PublishTime）；
 *   折算仅针对基准价，卖出价不参与折算（无银行单边卖出价语义，录入场景回退基准价）；
 * - 防滥用（方案 §3.4）：进程内全局并发 1（进行中外呼被并发请求复用）+ 最小外呼间隔 10s
 *   （间隔内的请求复用最近一次成功全表；首呼失败后的间隔窗口内快速失败，不等待不堆积）；
 * - 农行牌价仅提供当前全表，无历史序列接口：fetchHistory 返回空数组，历史由本地落库承担。
 */
export class AbcSource implements RateSource {
	readonly source = "abc";

	private readonly timeoutMs: number;
	private readonly transport: AbcTransport;
	private readonly minIntervalMs: number;
	private readonly now: () => number;

	/** 进行中的全表外呼（并发 1：后续请求复用同一 Promise，不发起第二次外呼） */
	private inFlight: Promise<AbcTable> | null = null;
	/** 最近一次成功解析的全表（最小间隔内的复用来源） */
	private lastTable: AbcTable | null = null;
	/** 最近一次真实外呼的发起时刻（失败也计时：任意两次外呼间隔 ≥ minIntervalMs） */
	private lastFetchAt = -Infinity;

	constructor(options: AbcSourceOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? ABC_RATE_TIMEOUT_MS;
		this.transport = options.transport ?? defaultAbcTransport;
		this.minIntervalMs = options.minIntervalMs ?? ABC_MIN_FETCH_INTERVAL_MS;
		this.now = options.now ?? (() => Date.now());
	}

	async fetchLatestBatch(
		base: string,
		targets: string[],
	): Promise<RateBatchQuote> {
		const table = await this.getTable();
		this.assertTargetsValid(base, targets, table);

		// base→CNY：CNY base 直接用表内对 CNY 价；base 行缺失 → 该组结构性不可提供（逐目标缺失 → 422）
		const baseRow = base === "CNY" ? undefined : table.rows.get(base);
		const baseToCny =
			base === "CNY"
				? ({ digits: 1n, scale: 0 } as const)
				: baseRow !== undefined
					? parseFixedPoint(baseRow.rate)
					: undefined;
		const quotes: Record<string, RatePairQuote> = {};
		if (baseToCny === undefined) {
			return { source: this.source, quotes };
		}

		for (const target of targets) {
			const entry = table.rows.get(target);
			if (entry === undefined) continue; // 表内无此币种 → 币对不支持（由调用方标记）
			const targetToCny = parseFixedPoint(entry.rate)!;
			quotes[target] = {
				rate:
					base === "CNY"
						? divideFixed(targetToCny, { digits: 1n, scale: 0 }, 10)
						: divideFixed(targetToCny, baseToCny, 10),
				// 卖出价不参与折算：仅 CNY base 直接价具备银行现汇卖出价语义
				...(base === "CNY" && entry.sellRate !== undefined
					? { sellRate: entry.sellRate }
					: {}),
				observedAt: entry.observedAt,
				raw: entry.raw,
			};
		}
		return { source: this.source, quotes };
	}

	async fetchHistory(
		_base: string,
		_target: string,
		_start: string,
		_end: string,
	): Promise<RateHistoryPoint[]> {
		// 农行牌价无历史序列接口：历史查询依赖本地落库积累（service 本地优先，不外呼补缺）
		return [];
	}

	/** 涉及行（base + targets）命中无效集 → 源不可用（502），不静默降级不入库 */
	private assertTargetsValid(
		base: string,
		targets: string[],
		table: AbcTable,
	): void {
		const invalid = targets.filter((target) => table.invalidCodes.has(target));
		if (table.invalidCodes.has(base)) invalid.unshift(base);
		if (invalid.length > 0) {
			throw new BadGatewayException(
				`ABC 汇率源返回了无效牌价: ${[...new Set(invalid)].join(",")}`,
			);
		}
	}

	/**
	 * 获取全表（防滥用收敛点）：
	 * - 进行中外呼 → 复用（并发 1）；
	 * - 距上次外呼 < 最小间隔 → 有成功全表则复用之（等价强制走缓存）；无则快速失败
	 *   （首呼失败后的间隔窗口内不重试，由 service 层窗口缓存与前端轮询兜底）；
	 * - 否则发起外呼（发起即计时，失败也占用间隔，保证任意两次真实外呼 ≥ 最小间隔）。
	 */
	private async getTable(): Promise<AbcTable> {
		if (this.inFlight !== null) return this.inFlight;

		const elapsed = this.now() - this.lastFetchAt;
		if (elapsed < this.minIntervalMs) {
			if (this.lastTable !== null) return this.lastTable;
			throw new BadGatewayException(
				`ABC 汇率源最小外呼间隔 ${this.minIntervalMs}ms 内不重试，请稍后再试`,
			);
		}
		this.lastFetchAt = this.now();
		const promise = this.fetchTable()
			.then((table) => {
				// 成功结果供最小间隔内的后续请求复用（间隔内强制走缓存）
				this.lastTable = table;
				return table;
			})
			.finally(() => {
				this.inFlight = null;
			});
		this.inFlight = promise;
		return promise;
	}

	private async fetchTable(): Promise<AbcTable> {
		const body = await this.transport(ABC_RATE_URL, this.timeoutMs);
		let payload: AbcResponse;
		try {
			payload = JSON.parse(body) as AbcResponse;
		} catch {
			throw new BadGatewayException("ABC 汇率源返回了无法解析的响应");
		}
		if (payload?.ErrorCode !== "0") {
			throw new BadGatewayException(
				`ABC 汇率源返回错误码 ${payload?.ErrorCode ?? "unknown"}: ${payload?.ErrorMsg ?? ""}`.trim(),
			);
		}
		const table = payload?.Data?.Table;
		if (!Array.isArray(table)) {
			throw new BadGatewayException("ABC 汇率源响应缺少牌价表");
		}
		return this.parseTable(table);
	}

	/**
	 * 全表解析：CurrName 正则提取币种码；百外币单位 ÷ 100；基准价/卖出价双价映射；
	 * PublishTime → UTC。无效行记入 invalidCodes（涉及行查询时按源不可用处理），
	 * 无关币种（请求未涉及）的脏数据不拖垮本次请求。
	 */
	private parseTable(table: AbcTableRow[]): AbcTable {
		const rows = new Map<string, AbcTableEntry>();
		const invalidCodes = new Set<string>();
		const deadline = this.now() + RATE_CLOCK_SKEW_TOLERANCE_MS;

		for (const row of table) {
			// String() 包裹：上游脏类型（CurrName 非字符串）经 ToString 拒配而非抛
			// TypeError（旧行为等效 RegExp.exec 的隐式转换）；其余见 parseFixedPoint 注释
			const code = String(row.CurrName ?? "").match(CURR_CODE_PATTERN)?.[1];
			if (code === undefined) continue;

			const observedAt = row.PublishTime ? new Date(row.PublishTime) : undefined;
			const rate = parsePrice(row.BenchMarkPrice);
			// SellPrice 字段存在但为空串视为该行无卖出价；存在但不可解析/≤0 视为无效行
			const hasSellPrice = row.SellPrice !== undefined && row.SellPrice !== "";
			const sellPrice = hasSellPrice ? parsePrice(row.SellPrice) : undefined;
			const invalid =
				observedAt === undefined ||
				Number.isNaN(observedAt.getTime()) ||
				observedAt.getTime() > deadline ||
				rate === undefined ||
				(hasSellPrice && sellPrice === undefined);
			if (invalid) {
				invalidCodes.add(code);
				continue;
			}

			rows.set(code, {
				// 百外币单位 ÷ 100（定点运算，无浮点误差）
				rate: divideFixed(rate!, { digits: 100n, scale: 0 }, 10),
				...(sellPrice !== undefined
					? { sellRate: divideFixed(sellPrice, { digits: 100n, scale: 0 }, 10) }
					: {}),
				observedAt: observedAt!,
				raw: String(row.BenchMarkPrice),
			});
		}
		return { rows, invalidCodes };
	}
}
