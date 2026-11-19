import { BadGatewayException } from "@nestjs/common";
import { FRANKFURTER_RATE_URL } from "./rate.constants";
import { invertQuoteRate } from "./rate-invert";
import { RatePairUnsupportedException } from "./rate.errors";
import type {
	RateBatchQuote,
	RateHistoryPoint,
	RatePairQuote,
	RateSource,
} from "./rate-source";

export const DEFAULT_RATE_PROVIDER_TIMEOUT_MS = 5_000;

type FrankfurterLatestResponse = {
	date?: string;
	rates?: Record<string, string | number>;
};

type FrankfurterHistoryResponse = {
	rates?: Record<string, Record<string, string | number>>;
};

export interface FrankfurterSourceOptions {
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

/**
 * frankfurter（ECB 日更）数据源：现 rate.provider.ts 逻辑原样迁入（M1.2 行为零变化）。
 *
 * 负责 MYR 币对，并作为 RATE_SOURCE=frankfurter 整组单源降级开关的路径；
 * 日精度 date 解析、404 → 币对不支持、非 2xx → 502、超时语义全部保持。
 * 方向（MVP-F0-1）：上游 from/to 语义为「1 base = raw target」，
 * latest 与 history 均经 invertQuoteRate 精确取倒数为「1 target = X base」。
 */
export class FrankfurterSource implements RateSource {
	readonly source = "frankfurter";

	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch | undefined;

	constructor(options: FrankfurterSourceOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_RATE_PROVIDER_TIMEOUT_MS;
		this.fetchImpl = options.fetchImpl;
	}

	/**
	 * 批量取最新报价：`GET /latest?from={base}&to={t1,t2,…}`，
	 * 整组目标共享同一 observedAt，满足「同一时点的一组报价」。
	 * 404 → RatePairUnsupportedException（含任一未知币种时数据源对整批拒绝）；
	 * 缺某目标币种 → 该目标不出现在 quotes 映射，由调用方逐项标记。
	 */
	async fetchLatestBatch(
		base: string,
		targets: string[],
	): Promise<RateBatchQuote> {
		const targetsParam = targets.join(",");
		const response = await this.request<FrankfurterLatestResponse>(
			`${FRANKFURTER_RATE_URL}/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(targetsParam)}`,
			base,
			targetsParam,
		);

		const observedAt = this.parseDate(response.date);
		const quotes: Record<string, RatePairQuote> = {};
		for (const target of targets) {
			const rawRate = response.rates?.[target];
			if (rawRate !== undefined) {
				quotes[target] = {
					rate: invertQuoteRate(rawRate, base, target),
					observedAt,
					raw: String(rawRate),
				};
			}
		}
		return { source: this.source, quotes };
	}

	async fetchHistory(
		base: string,
		target: string,
		start: string,
		end: string,
	): Promise<RateHistoryPoint[]> {
		const response = await this.request<FrankfurterHistoryResponse>(
			`${FRANKFURTER_RATE_URL}/${encodeURIComponent(start)}..${encodeURIComponent(end)}?from=${encodeURIComponent(base)}&to=${encodeURIComponent(target)}`,
			base,
			target,
		);

		return Object.entries(response.rates ?? {})
			.sort(([left], [right]) => left.localeCompare(right))
			.flatMap(([date, rates]) => {
				const rawRate = rates[target];
				if (rawRate === undefined) return [];

				return [
					{
						// 上游「1 base = raw target」→ 取倒数（FX-01：仅转换一次）
						rate: invertQuoteRate(rawRate, base, target),
						observedAt: this.parseDate(date),
					},
				];
			});
	}

	private async request<TResponse>(
		url: string,
		base: string,
		target: string,
	): Promise<TResponse> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			// 每次调用时解析全局 fetch，兼容测试的 vi.stubGlobal 注入
			const doFetch = this.fetchImpl ?? globalThis.fetch;
			const response = await doFetch(url, {
				signal: controller.signal,
				headers: { Accept: "application/json" },
			});

			if (!response.ok) {
				// 404 表示数据源明确不提供该币对（如 ECB 无 TWD），与暂时性故障区分
				if (response.status === 404) {
					throw new RatePairUnsupportedException(base, target);
				}
				throw new RateSourceHttpError(response.status);
			}

			return (await response.json()) as TResponse;
		} catch (error) {
			if (error instanceof RatePairUnsupportedException) {
				throw error;
			}
			throw new BadGatewayException("汇率供应商暂时不可用");
		} finally {
			clearTimeout(timeout);
		}
	}

	/** v1 日期 → UTC 零点；缺失/非法日期一律拒绝（FX-01：不得回落系统时间冒充报价时点） */
	private parseDate(value: unknown): Date {
		// 上游 JSON 不可信：非字符串（null/数字/对象）一律按缺失日期拒绝，避免 TypeError 裸抛
		if (typeof value !== "string" || value.trim() === "") {
			throw new BadGatewayException("汇率供应商缺少报价日期");
		}
		// 严格 YYYY-MM-DD + 反向比对：拒绝 2026-02-29 这类不存在日历日期被
		// new Date() 静默归一化（如滚动到 03-01）伪造 observedAt
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
			throw new BadGatewayException("汇率供应商返回了无效日期");
		}
		const date = new Date(`${value}T00:00:00.000Z`);
		if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
			throw new BadGatewayException("汇率供应商返回了无效日期");
		}
		return date;
	}
}

/** 数据源返回非 2xx 的内部信号错误，由调用方决定是否转换为币对不支持 */
class RateSourceHttpError extends Error {
	constructor(readonly status: number) {
		super(`Frankfurter responded with ${status}`);
		this.name = 'RateSourceHttpError';
	}
}
