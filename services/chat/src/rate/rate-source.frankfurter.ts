import { BadGatewayException } from "@nestjs/common";
import { FRANKFURTER_RATE_URL } from "./rate.constants";
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
					rate: String(rawRate),
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

				return [{ rate: String(rawRate), observedAt: this.parseDate(date) }];
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

	private parseDate(value: string | undefined): Date {
		const date = value ? new Date(`${value}T00:00:00.000Z`) : new Date();
		if (Number.isNaN(date.getTime())) {
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
