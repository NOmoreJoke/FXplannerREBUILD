import { BadGatewayException, Inject, Injectable, Optional } from '@nestjs/common';
import {
	ABC_CURRENCIES,
	ABC_RATE_TIMEOUT_MS,
	MULTI_RATE_SOURCE,
	resolveRateSourceMode,
	type RateSourceMode,
} from './rate.constants';
import { RatePairUnsupportedException } from './rate.errors';
import { AbcSource, type AbcTransport } from './rate-source.abc';
import { ErApiSource } from './rate-source.erapi';
import {
	DEFAULT_RATE_PROVIDER_TIMEOUT_MS,
	FrankfurterSource,
} from './rate-source.frankfurter';
import type {
	RateBatchQuote,
	RateHistoryPoint,
	RateQuote,
	RateSource,
} from './rate-source';

export const RATE_PROVIDER_TIMEOUT_TOKEN = 'RATE_PROVIDER_TIMEOUT_MS';
export { DEFAULT_RATE_PROVIDER_TIMEOUT_MS };
export type { RateBatchQuote, RateHistoryPoint, RateQuote };

/**
 * 汇率数据源门面（realtime-rate 方案 §3.1）：对 RateService 的接口签名与 M1.2 完全一致。
 *
 * - 缺省：多源路由——按 target 静态分组（ABC 12 币种 / TWD → er-api / 其余 → frankfurter），
 *   单组直接透传（单源失败语义与 M1.2 一致）；混合组并发外呼，成功项合并，
 *   失败源的币对进 failures（service 逐项 502 下沉，不拖垮同组）；
 * - RATE_SOURCE=frankfurter：整组走 frankfurter 单源（= M1.2 行为，整体降级开关）；
 * - 恒等币对（base=target）不进本门面（service 层本地生成，source="identity"）。
 */
@Injectable()
export class RateProvider {
	private readonly mode: RateSourceMode;
	private readonly timeoutMs: number;
	private readonly abcSource: AbcSource;
	private readonly erApiSource: ErApiSource;
	private readonly frankfurterSource: FrankfurterSource;

	constructor(
		@Optional()
		@Inject(RATE_PROVIDER_TIMEOUT_TOKEN)
		timeoutMs?: number,
		@Optional()
		fetchImpl?: typeof fetch,
	) {
		this.timeoutMs = timeoutMs ?? DEFAULT_RATE_PROVIDER_TIMEOUT_MS;
		// 构造时解析 env（非模块加载期），便于测试按实例切换多源/降级模式
		this.mode = resolveRateSourceMode();
		// 注入的 fetchImpl 适配为 ABC 传输函数（测试拦截用，方案 §8.2「门面透传注入的 fetchImpl stub」）；
		// 生产无注入时 ABC 走 node:https + legacy TLS 默认实现
		const abcTransport: AbcTransport | undefined = fetchImpl
			? async (url, timeoutMs) => {
					const response = await fetchImpl(url, {
						signal: AbortSignal.timeout(timeoutMs),
						headers: { Accept: '*/*' },
					});
					if (!response.ok) {
						throw new BadGatewayException(
							`ABC 汇率源响应状态 ${response.status}`,
						);
					}
					return response.text();
				}
			: undefined;
		this.abcSource = new AbcSource({
			timeoutMs: ABC_RATE_TIMEOUT_MS,
			transport: abcTransport,
		});
		this.erApiSource = new ErApiSource({
			timeoutMs: this.timeoutMs,
			fetchImpl,
		});
		this.frankfurterSource = new FrankfurterSource({
			timeoutMs: this.timeoutMs,
			fetchImpl,
		});
	}

	async fetchLatest(base: string, target: string): Promise<RateQuote> {
		const batch = await this.fetchLatestBatch(base, [target]);
		const quote = batch.quotes[target];

		if (quote === undefined) {
			// 数据源应答正常但无目标币种报价（如 ECB 无 TWD），属于币对不支持，重试无用
			throw new RatePairUnsupportedException(base, target);
		}

		return {
			base,
			quote: target,
			rate: quote.rate,
			...(quote.sellRate !== undefined ? { sellRate: quote.sellRate } : {}),
			source: batch.sources?.[target] ?? batch.source,
			observedAt: quote.observedAt,
		};
	}

	/**
	 * 批量取最新报价：按 target 路由到各数据源（见类注释）。
	 * 数据源未提供的目标不出现在 quotes 映射（由调用方标记币对不支持）；
	 * 多源部分失败时失败币对进 failures（502 语义，由调用方逐项下沉）。
	 */
	async fetchLatestBatch(base: string, targets: string[]): Promise<RateBatchQuote> {
		if (this.mode === 'frankfurter') {
			return this.frankfurterSource.fetchLatestBatch(base, targets);
		}
		return this.fetchMultiSource(base, targets);
	}

	async fetchHistory(
		base: string,
		target: string,
		start: string,
		end: string,
	): Promise<RateHistoryPoint[]> {
		return this.sourceFor(target).fetchHistory(base, target, start, end);
	}

	/** 币对路由的数据源标识（history 落库 source 标注用；降级模式恒为 frankfurter） */
	sourceForPair(_base: string, target: string): string {
		return this.sourceFor(target).source;
	}

	/** 币对静态路由：ABC 12 币种 → 农行牌价；TWD → er-api；其余（MYR 等）→ frankfurter */
	private sourceFor(target: string): RateSource {
		if (this.mode === 'frankfurter') return this.frankfurterSource;
		if ((ABC_CURRENCIES as readonly string[]).includes(target)) {
			return this.abcSource;
		}
		if (target === 'TWD') return this.erApiSource;
		return this.frankfurterSource;
	}

	private async fetchMultiSource(
		base: string,
		targets: string[],
	): Promise<RateBatchQuote> {
		const groups = new Map<RateSource, string[]>();
		for (const target of targets) {
			const source = this.sourceFor(target);
			const group = groups.get(source);
			if (group !== undefined) {
				group.push(target);
			} else {
				groups.set(source, [target]);
			}
		}

		// 单组：直接透传，保持单源失败语义（异常上抛 → service 整批失败分支）
		if (groups.size === 1) {
			const [[source, groupTargets]] = groups;
			return source.fetchLatestBatch(base, groupTargets);
		}

		// 混合组：并发外呼；任一源失败仅其币对下沉 502，其余币对不受影响
		const entries = [...groups.entries()];
		const settled = await Promise.allSettled(
			entries.map(([source, groupTargets]) =>
				source.fetchLatestBatch(base, groupTargets),
			),
		);

		const merged: RateBatchQuote = {
			source: MULTI_RATE_SOURCE,
			quotes: {},
			sources: {},
			failures: {},
		};
		for (const [index, outcome] of settled.entries()) {
			const [source, groupTargets] = entries[index];
			if (outcome.status === 'fulfilled') {
				for (const target of groupTargets) {
					const quote = outcome.value.quotes[target];
					if (quote !== undefined) {
						merged.quotes[target] = quote;
						merged.sources![target] = source.source;
					}
					// 组内缺失目标：不进 failures → service 标记币对不支持（422）
				}
			} else {
				for (const target of groupTargets) {
					merged.failures![target] = outcome.reason;
				}
			}
		}
		return merged;
	}
}
