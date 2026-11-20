import { BadGatewayException } from "@nestjs/common";
import {
	ERAPI_RATE_URL,
	RATE_CLOCK_SKEW_TOLERANCE_MS,
} from "./rate.constants";
import { DEFAULT_RATE_PROVIDER_TIMEOUT_MS } from "./rate-source.frankfurter";
import { parseRateResponse } from "./rate-source-json";
import type {
	RateBatchQuote,
	RateHistoryPoint,
	RatePairQuote,
	RateSource,
} from "./rate-source";

interface ErApiLatestResponse {
	/** 免费档固定 "success" */
	result?: string;
	/** 报价更新时间（Unix 秒，日更） */
	time_last_update_unix?: number;
	rates?: Record<string, string | number>;
}

export interface ErApiSourceOptions {
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

/**
 * TWD 补充源：ExchangeRate-API 免费档（open.er-api.com，日更，零 key）。
 *
 * - 方向：上游 `/latest/{base}` 返回「1 base = raw target」，经 invertQuoteRate
 *   精确取倒数为「1 target = X base」（MVP-F0-1 统一口径，定点 HALF_UP 10 位）；
 * - `time_last_update_unix` → observedAt（日精度语义如实标注）；
 * - 历史能力：免费档历史端点受限（方案 §6 实测项），fetchHistory 返回空数组，
 *   TWD 历史由本地落库积累承担（service 本地优先，不外呼补缺）。
 */
export class ErApiSource implements RateSource {
	readonly source = "er-api";

	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch | undefined;

	constructor(options: ErApiSourceOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_RATE_PROVIDER_TIMEOUT_MS;
		this.fetchImpl = options.fetchImpl;
	}

	async fetchLatestBatch(
		base: string,
		targets: string[],
	): Promise<RateBatchQuote> {
		const { data: response, readQuote } = await this.request(
			`${ERAPI_RATE_URL}/latest/${encodeURIComponent(base)}`,
		);
		if (response.result !== undefined && response.result !== "success") {
			throw new BadGatewayException(
				`er-api 汇率源返回结果 ${response.result}`,
			);
		}
		const observedAt = this.parseObservedAt(response.time_last_update_unix);

		const quotes: Record<string, RatePairQuote> = {};
		for (const target of targets) {
			const quote = readQuote(response.rates, base, target);
			if (quote) quotes[target] = { ...quote, observedAt };
		}
		return { source: this.source, quotes };
	}

	async fetchHistory(
		_base: string,
		_target: string,
		_start: string,
		_end: string,
	): Promise<RateHistoryPoint[]> {
		return [];
	}

	/** time_last_update_unix → UTC；缺失/不可解析/晚于 now+容差（恰好容差值放行）→ 源不可用 */
	private parseObservedAt(unixSeconds: number | undefined): Date {
		if (
			unixSeconds === undefined ||
			!Number.isFinite(unixSeconds) ||
			unixSeconds <= 0
		) {
			throw new BadGatewayException("er-api 汇率源缺少报价时间");
		}
		const observedAt = new Date(unixSeconds * 1000);
		if (
			observedAt.getTime() >
			Date.now() + RATE_CLOCK_SKEW_TOLERANCE_MS
		) {
			throw new BadGatewayException("er-api 汇率源返回了未来报价时间");
		}
		return observedAt;
	}

	private async request(url: string) {
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
				throw new BadGatewayException(`er-api 汇率源响应状态 ${response.status}`);
			}

			return parseRateResponse<ErApiLatestResponse>(await response.text());
		} catch (error) {
			if (error instanceof BadGatewayException) {
				throw error;
			}
			throw new BadGatewayException("er-api 汇率源暂时不可用");
		} finally {
			clearTimeout(timeout);
		}
	}
}
