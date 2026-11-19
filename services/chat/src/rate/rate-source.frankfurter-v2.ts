import { BadGatewayException } from "@nestjs/common";
import {
	FRANKFURTER_V2_RATE_URL,
	RATE_CLOCK_SKEW_TOLERANCE_MS,
} from "./rate.constants";
import { invertQuoteRate } from "./rate-invert";
import { DEFAULT_RATE_PROVIDER_TIMEOUT_MS } from "./rate-source.frankfurter";
import type { RateHistoryPoint } from "./rate-source";

/**
 * v2 响应条目（底稿 §1 实测契约：逐条 date/base/quote/rate 记录）。
 * 防御性兼容 v1 风格嵌套 map（rates[date][target]），两类形状同套校验。
 */
type FrankfurterV2SeriesEntry = { date: unknown; rate: unknown };
type FrankfurterV2SeriesResponse = {
	rates?: Array<Record<string, unknown>> | Record<string, unknown>;
};

export interface FrankfurterV2SourceOptions {
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

/**
 * frankfurter v2 日级参考序列源（MVP-F0-2 C2·TWD 图表冷缺口补点）。
 *
 * - 仅产出参考序列（`GET /v2/rates?base={base}&quotes={target}&from&to`），
 *   供图表响应合并层使用；严禁回写 exchange_rates（与现行键、createdAt 刷新、
 *   原时点/最新报价候选完全隔离，realtime-rate 底稿 §2「图表与缓存隔离」）；
 * - 方向（MVP-F0-1）：v2 返回「1 base = X target」，经 invertQuoteRate 精确取倒数
 *   为「1 target = X base」，与本地落库序列同向（仅转换一次，FX-01）；
 * - `date` 仅证明序列日期：严格 YYYY-MM-DD + 反向比对，缺失/非法/未来日期拒绝
 *   （缺目标币种的条目同样先过日期校验，不得绕过）；
 * - 序列按请求区间 [start, end] 过滤（上游越界日期不外溢），按日期升序输出；
 *   供应商返回的周末日期原样保留（不自行生成/不剔除）；
 * - 参考点不可用于原时点入账（无当时可用性证据）。
 */
export class FrankfurterV2Source {
	readonly source = "frankfurter-v2-reference";

	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch | undefined;

	constructor(options: FrankfurterV2SourceOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_RATE_PROVIDER_TIMEOUT_MS;
		this.fetchImpl = options.fetchImpl;
	}

	/** [start, end] 区间参考序列（YYYY-MM-DD；按日期升序） */
	async fetchReferenceSeries(
		base: string,
		target: string,
		start: string,
		end: string,
	): Promise<RateHistoryPoint[]> {
		const response = await this.request<FrankfurterV2SeriesResponse>(
			`${FRANKFURTER_V2_RATE_URL}/rates?base=${encodeURIComponent(base)}&quotes=${encodeURIComponent(target)}&from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`,
		);

		const entries = this.normalizeRates(response.rates, target);
		const startMs = this.parseDate(start, "区间起点").getTime();
		const endMs = this.parseDate(end, "区间终点").getTime();
		const endExclusive = endMs + 86_400_000;

		return entries
			.map((entry) => ({
				// 日期校验先行：所有逐条记录（含非目标币对/缺 quote 条目）一律过校验，
				// 不得借 quote 过滤绕过非法日期（FX-01）
				observedAt: this.parseDate(entry.date, "参考序列"),
				isTarget: entry.isTarget,
				rawRate: entry.rate,
			}))
			.filter((entry) => entry.isTarget && entry.rawRate !== undefined)
			.map((entry) => ({
				rate: invertQuoteRate(entry.rawRate as string | number, base, target),
				observedAt: entry.observedAt,
			}))
			.filter(
				(point) =>
					point.observedAt.getTime() >= startMs &&
					point.observedAt.getTime() < endExclusive,
			)
			.sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime());
	}

	/**
	 * v2 rates 归一：优先实测的逐条记录契约（条目自带 quote 币对标识，
	 * 仅 quote === target 的条目计入——缺 quote 不视为目标）；兼容 v1 风格
	 * 嵌套 map（rates[date][target]，键位即目标币种，天然 isTarget）。
	 */
	private normalizeRates(
		raw: unknown,
		target: string,
	): Array<{ date: unknown; rate: unknown; isTarget: boolean }> {
		if (Array.isArray(raw)) {
			return raw.map((entry) => {
				const record = entry as Record<string, unknown> | undefined;
				return {
					date: record?.date,
					rate: record?.rate,
					isTarget: record?.quote === target,
				};
			});
		}
		if (raw !== null && typeof raw === "object") {
			return Object.entries(
				raw as Record<string, Record<string, string | number>>,
			).map(([date, rates]) => ({
				date,
				rate: (rates ?? {})[target],
				isTarget: true,
			}));
		}
		return [];
	}

	/**
	 * v2 date → UTC 零点；缺失/非法/不存在日历日期/未来日期一律拒绝（FX-01：
	 * 不得回落系统时间；date 仅证明序列日期，未来日期本身即越界数据）。
	 */
	private parseDate(value: unknown, context: string): Date {
		if (typeof value !== "string" || value.trim() === "") {
			throw new BadGatewayException(`${context}缺少日期`);
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
			throw new BadGatewayException(`${context}返回了无效日期`);
		}
		const date = new Date(`${value}T00:00:00.000Z`);
		if (
			Number.isNaN(date.getTime()) ||
			date.toISOString().slice(0, 10) !== value
		) {
			throw new BadGatewayException(`${context}返回了无效日期`);
		}
		if (date.getTime() > Date.now() + RATE_CLOCK_SKEW_TOLERANCE_MS) {
			throw new BadGatewayException(`${context}返回了未来日期`);
		}
		return date;
	}

	private async request<TResponse>(url: string): Promise<TResponse> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const doFetch = this.fetchImpl ?? globalThis.fetch;
			const response = await doFetch(url, {
				signal: controller.signal,
				headers: { Accept: "application/json" },
			});

			if (!response.ok) {
				throw new BadGatewayException(`参考序列响应状态 ${response.status}`);
			}

			return (await response.json()) as TResponse;
		} catch (error) {
			if (error instanceof BadGatewayException) {
				throw error;
			}
			throw new BadGatewayException("参考序列暂时不可用");
		} finally {
			clearTimeout(timeout);
		}
	}
}
