import { roundRateTo8 } from '@fxplanner-new/money';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { utc8DayStart } from '../transaction/transaction-calculator';
import {
  DAILY_QUOTE_LOOKBACK_DAYS,
  DAILY_QUOTE_SOURCES,
  IDENTITY_RATE_SOURCE,
  isSupportedCurrency,
  normalizeCurrency,
  QUOTE_TTL_MS,
  REALTIME_QUOTE_SOURCES,
  SUPPORTED_CURRENCIES,
  VALID_PERIODS,
  type RatePeriod,
} from './rate.constants';
import {
  RatePairUnsupportedException,
  RateSourceUnavailableException,
} from './rate.errors';
import { RateProvider, type RateHistoryPoint } from './rate.provider';

/** ExchangeRate 行中本模块关心的字段（rate 为 Prisma Decimal，mock 下可为任意 toString 对象） */
interface LatestRow {
  quote: string;
  rate: { toString(): string };
  sellRate?: { toString(): string } | null;
  source: string;
  observedAt: Date;
  createdAt: Date;
}

/** 项级成功数据：confirmedAt = 最后一次确认时间（窗口基准） */
interface LatestQuoteData {
  rate: string;
  /** 现汇卖出价（仅 abc 源有值；缺省 = 无卖出价，录入场景回退 rate） */
  sellRate?: string;
  source: string;
  observedAt: Date;
  confirmedAt: Date;
}

/** 项级错误（多目标时下沉到 items，不拖垮同组；doc 05：绝不返回过期报价/0/手填价） */
export interface LatestQuoteError {
  code: 'RATE_PAIR_UNSUPPORTED' | 'RATE_SOURCE_UNAVAILABLE';
  message: string;
  lastObservedAt: string | null;
}

/** 落库参数（persistQuote 的 options 对象） */
interface QuoteToPersist {
  base: string;
  target: string;
  rate: string;
  /** 现汇卖出价（仅 abc 源；缺省时 upsert 不触碰该列，避免洗掉同行已有值） */
  sellRate?: string;
  source: string;
  observedAt: Date;
  confirmedAt: Date;
}

type GroupResult = Map<string, LatestQuoteData | LatestQuoteError>;

/**
 * 历史回源负缓存 TTL：回源后仍不完整的币对 10 分钟内不再重试回源
 * （rate-chart 方案 §6，防「永远补不齐币对」的外呼放大器）
 */
const HISTORY_NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;

/** 单目标平铺响应（契约见 dto/rate-latest.dto.ts LatestRateResponseDto） */
export interface LatestRateResponse {
  base: string;
  target: string;
  rate: string;
  /** 现汇卖出价（仅 abc 源返回，8 位小数；缺省 = 无卖出价） */
  sellRate?: string;
  source: string;
  observedAt: string;
  validUntil: string;
  fresh: boolean;
}

/** 多目标响应项：成功（含报价元数据）或失败（错误下沉），契约见 LatestRateItemDto */
export interface LatestRateItemSuccess {
  target: string;
  rate: string;
  /** 现汇卖出价（仅 abc 源返回，8 位小数；缺省 = 无卖出价） */
  sellRate?: string;
  source: string;
  observedAt: string;
  validUntil: string;
  fresh: boolean;
}

export interface LatestRateItemFailure {
  target: string;
  error: LatestQuoteError;
}

export type LatestRateItem = LatestRateItemSuccess | LatestRateItemFailure;

/** 多目标响应（契约见 LatestRateGroupResponseDto） */
export interface LatestRateGroupResponse {
  base: string;
  items: LatestRateItem[];
}

@Injectable()
export class RateService {
  /** 进程内单飞：同 base+targets 的进行中回源被后续请求复用（单实例语义，方案 §3.3） */
  private readonly inFlight = new Map<string, Promise<GroupResult>>();
  /** 历史回源 in-flight 单飞：同币对的进行中 fetchHistory 被并发缺口请求复用（rate-chart 方案 §6） */
  private readonly historyInFlight = new Map<string, Promise<RateHistoryPoint[]>>();
  /** 历史回源负缓存：币对 → 负缓存过期时间戳，窗口内不再回源直接返回积累序列（rate-chart 方案 §6） */
  private readonly historyNegativeCache = new Map<string, number>();

  private readonly logger = new Logger(RateService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RateProvider) private readonly provider: RateProvider,
  ) {}

  getSupported(): string[] {
    return [...SUPPORTED_CURRENCIES];
  }

  /** 全表最新汇率观测时间（无任何汇率数据时为 null；首页顶栏「最新刷新」数据源，home-state-routing 方案 §4.2） */
  async getLatestObservedAt(): Promise<Date | null> {
    const aggregated = await this.prisma.exchangeRate.aggregate({
      _max: { observedAt: true },
    });
    return aggregated._max.observedAt;
  }

  /**
   * 最新报价：批量 targets、5 分钟有效期窗口、单飞回源、陈旧回显（SWR）。
   *
   * - 窗口基准 = ExchangeRate.createdAt 物化的「最后确认时间」：回源成功（update 分支）
   *   显式刷新 createdAt = now → 窗口重置；缓存命中/陈旧回显绝不触碰 → 不重置
   *   （方案 §2.2 裁决，schema 冻结下 updatedAt 语义的等价落点）；
   * - fresh = now < createdAt + 5min（严格小于，恰好满 5 分钟过期）；
   * - 同币种恒等报价 rate="1" 本地生成不外呼；
   * - refresh=false 的三档决策（changes/rate-stale-echo-fix/技术方案.md §3.1）：
   *   ① 全部目标窗口内 → 命中返回；② 全部目标有行但超窗 → 立即回显旧值
   *   （fresh=false 如实标注）+ 后台异步单飞回源（失败仅告警不上抛）；
   *   ③ 任一目标无行（冷启动）→ 同步回源；
   * - refresh=true 或冷启动路径：整组一次外呼（同一时点），错误逐项下沉或按单目标上抛。
   */
  async getLatest(base: string, targets?: string[], refresh = false) {
    const normalizedBase = this.validateCurrency(base, 'base');
    const requested = this.normalizeTargets(targets);
    const externalTargets = requested.filter((target) => target !== normalizedBase);

    const rows = await this.findLatestRows(normalizedBase, requested);
    const now = Date.now();
    const allFresh = requested.every((target) => {
      const row = rows.get(target);
      return row !== undefined && now < row.createdAt.getTime() + QUOTE_TTL_MS;
    });

    let group: GroupResult;
    if (!refresh && allFresh) {
      group = this.cachedGroup(requested, rows);
    } else if (!refresh && requested.every((target) => rows.has(target))) {
      // SWR 陈旧回显：库内齐但超窗 → 先用旧值响应（不阻塞），后台异步回源落库；
      // 回源成功经 upsert 刷新 createdAt 重置窗口，前端轮询自然拿到新值
      group = this.cachedGroup(requested, rows);
      this.kickBackgroundRefresh(
        normalizedBase,
        requested,
        externalTargets,
        rows,
      );
    } else {
      group = await this.refreshWithSingleFlight(
        normalizedBase,
        requested,
        externalTargets,
        rows,
      );
    }

    if (requested.length === 1) {
      // 单目标：组内错误项以 HTTP 语义上抛（422 币对不支持 / 502 数据源不可用）
      const item = this.toItem(requested[0], group.get(requested[0])!);
      if (!('rate' in item)) {
        throw item.error.code === 'RATE_PAIR_UNSUPPORTED'
                ? new RatePairUnsupportedException(normalizedBase, requested[0])
                : new RateSourceUnavailableException(item.error.lastObservedAt);
      }
      return { base: normalizedBase, ...item } satisfies LatestRateResponse;
    }
    return {
      base: normalizedBase,
      items: requested.map((target) => this.toItem(target, group.get(target)!)),
    } satisfies LatestRateGroupResponse;
  }

  /**
   * 原时点取价（corrections 技术方案 §5.3，初始持仓币种更正依赖；MVP-F0-2 按源粒度分组）：
   *
   * - 实时源（abc）：observedAt ∈ (at − 5min, at] 窗口最后一笔（doc 02 机制原样）；
   * - 日级源（er-api，真实供应商发布时间）：UTC+8 同日且 observedAt ≤ at 的最近合格点，
   *   未命中按最多 7 个 UTC+8 自然日有限回看（节假日/停更场景；未来点一律排除）；
   * - frankfurter 等仅日期源：date 零点只是日期表示，无法证明原时点可用 → 不参与
   *   原时点入账（上层保留 RATE_QUOTE_UNAVAILABLE）；
   * - 本地皆无则按当前路由源 fetchHistory 回补当日历史后重查（skipDuplicates 幂等；
   *   er-api 免费档无历史端点返回空数组，回补只对具备真实历史的源产生可用行）；
   * - 仍无 → 返回 null，上层抛 400 RATE_QUOTE_UNAVAILABLE。严禁伪造 observedAt。
   * 方向与采用价口径与 onboarding 取价一致（sellRate ?? rate，1 外币 = X 本位币）。
   */
  async findQuoteAt(
    baseCurrency: string,
    currencyCode: string,
    at: Date,
  ): Promise<{
    rate: string;
    sellRate?: string;
    source: string;
    observedAt: Date;
  } | null> {
    const realtimeWindowStart = new Date(at.getTime() - QUOTE_TTL_MS);
    const lookbackStart = new Date(
      utc8DayStart(at).getTime() -
        DAILY_QUOTE_LOOKBACK_DAYS * 86_400_000,
    );

    const findRealtime = () =>
      this.prisma.exchangeRate.findFirst({
        where: {
          base: baseCurrency,
          quote: currencyCode,
          source: { in: [...REALTIME_QUOTE_SOURCES] },
          observedAt: { gt: realtimeWindowStart, lte: at },
        },
        orderBy: { observedAt: 'desc' },
      });
    const findDaily = () =>
      this.prisma.exchangeRate.findFirst({
        where: {
          base: baseCurrency,
          quote: currencyCode,
          source: { in: [...DAILY_QUOTE_SOURCES] },
          observedAt: { gte: lookbackStart, lte: at },
        },
        orderBy: { observedAt: 'desc' },
      });

    let row = await findRealtime();
    if (!row) {
      row = await findDaily();
    }
    if (!row) {
      // 本地无合格报价：回补当日历史后重查（与 getHistory 同一落库通道，skipDuplicates 幂等）
      const dayStart = utc8DayStart(at);
      try {
        const fetched = await this.provider.fetchHistory(
          baseCurrency,
          currencyCode,
          this.formatDate(dayStart),
          this.formatDate(at),
        );
        if (fetched.length > 0) {
          await this.prisma.exchangeRate.createMany({
            data: fetched.map((point) => ({
              base: baseCurrency,
              quote: currencyCode,
              rate: point.rate,
              source: this.provider.sourceForPair(baseCurrency, currencyCode),
              observedAt: point.observedAt,
            })),
            skipDuplicates: true,
          });
        }
      } catch {
        // 数据源不可用：不阻断失败路径，按「无合格报价」处理（返回 null）
      }
      row = (await findRealtime()) ?? (await findDaily());
    }
    if (!row) return null;
    return {
      rate: row.rate.toString(),
      ...(row.sellRate != null ? { sellRate: row.sellRate.toString() } : {}),
      source: row.source,
      observedAt: row.observedAt,
    };
  }

  async getHistory(base: string, target: string, period: number) {
    const normalizedBase = this.validateCurrency(base, 'base');
    const normalizedTarget = this.validateCurrency(target, 'target');
    const normalizedPeriod = this.validatePeriod(period);
    const end = this.startOfUtcDay(new Date());
    const start = new Date(end.getTime() - normalizedPeriod * 86_400_000);

    const cached = await this.prisma.exchangeRate.findMany({
      where: {
        base: normalizedBase,
        quote: normalizedTarget,
        observedAt: { gte: start, lte: end },
      },
      orderBy: { observedAt: 'asc' },
    });

    if (
      cached.length > 0 &&
      (normalizedBase === normalizedTarget || this.isHistoryCacheComplete(cached, start, end))
    ) {
      return this.toHistoryResponse(normalizedBase, normalizedTarget, normalizedPeriod, cached);
    }

    // 回源防护（rate-chart 方案 §6）：负缓存窗口内不再外呼，直接返回积累序列；
    // 并发缺口请求经单飞合并为一次回源——防「永远补不齐币对」的回源放大器。
    // 两个防护对 7/30/90/365 全部档位同样生效（行为增强，非仅 365）。
    const pairKey = `${normalizedBase}|${normalizedTarget}`;
    const negativeUntil = this.historyNegativeCache.get(pairKey);
    const negativeCached =
      negativeUntil !== undefined && Date.now() < negativeUntil;
    if (negativeCached) {
      this.logger.debug(
        `历史回源负缓存命中（${pairKey}），窗口内直接返回积累序列`,
      );
    }

    let fetched: RateHistoryPoint[] = [];
    if (normalizedBase === normalizedTarget) {
      fetched = this.localHistory(start, end);
    } else if (!negativeCached) {
      fetched = await this.fetchHistoryWithSingleFlight(
        pairKey,
        normalizedBase,
        normalizedTarget,
        start,
        end,
      );
    }

    if (fetched.length > 0) {
      await this.prisma.exchangeRate.createMany({
        data: fetched.map((point) => ({
          base: normalizedBase,
          quote: normalizedTarget,
          rate: point.rate,
          // 恒等序列为数学事实（identity）；外部序列按币对路由的实际数据源标注
          source:
            normalizedBase === normalizedTarget
              ? IDENTITY_RATE_SOURCE
              : this.provider.sourceForPair(normalizedBase, normalizedTarget),
          observedAt: point.observedAt,
        })),
        skipDuplicates: true,
      });
    }

    const saved = await this.prisma.exchangeRate.findMany({
      where: {
        base: normalizedBase,
        quote: normalizedTarget,
        observedAt: { gte: start, lte: end },
      },
      orderBy: { observedAt: 'asc' },
    });

    // 负缓存登记：真实回源后仍不完整的币对（含回源为空序列的数据源）→
    // 10 分钟内不再重试回源（方案 §6）；负缓存命中路径不刷新窗口，
    // 保证窗口期满必然重新尝试。恒等币对本地生成不外呼，不参与登记。
    if (
      normalizedBase !== normalizedTarget &&
      !negativeCached &&
      !this.isHistoryCacheComplete(saved, start, end)
    ) {
      this.historyNegativeCache.set(
        pairKey,
        Date.now() + HISTORY_NEGATIVE_CACHE_TTL_MS,
      );
    }

    return this.toHistoryResponse(normalizedBase, normalizedTarget, normalizedPeriod, saved);
  }

  /** 历史回源单飞：同币对进行中的 fetchHistory 复用给并发缺口请求，结束即清除（rate-chart 方案 §6） */
  private fetchHistoryWithSingleFlight(
    pairKey: string,
    base: string,
    target: string,
    start: Date,
    end: Date,
  ): Promise<RateHistoryPoint[]> {
    const existing = this.historyInFlight.get(pairKey);
    if (existing) return existing;

    const promise = this.provider
      .fetchHistory(base, target, this.formatDate(start), this.formatDate(end))
      .finally(() => {
        this.historyInFlight.delete(pairKey);
      });
    this.historyInFlight.set(pairKey, promise);
    return promise;
  }

  private isHistoryCacheComplete(
    rates: Array<{ observedAt: Date }>,
    start: Date,
    end: Date,
  ): boolean {
    if (rates.length === 0) return false;

    const cachedDates = new Set(
      rates.map((rate) => rate.observedAt.toISOString().slice(0, 10)),
    );
    const firstBusinessDay = this.nextBusinessDay(start);
    const lastCompletedBusinessDay = this.previousBusinessDay(end);

    for (
      const cursor = firstBusinessDay;
      cursor <= lastCompletedBusinessDay;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      const day = cursor.getUTCDay();
      if (day === 0 || day === 6) continue;
      if (!cachedDates.has(this.formatDate(cursor))) return false;
    }

    return true;
  }

  private nextBusinessDay(value: Date): Date {
    const result = new Date(value);
    while (result.getUTCDay() === 0 || result.getUTCDay() === 6) {
      result.setUTCDate(result.getUTCDate() + 1);
    }
    return result;
  }

  private previousBusinessDay(value: Date): Date {
    const result = new Date(value);
    result.setUTCDate(result.getUTCDate() - 1);
    while (result.getUTCDay() === 0 || result.getUTCDay() === 6) {
      result.setUTCDate(result.getUTCDate() - 1);
    }
    return result;
  }

  private validateCurrency(value: string, field: 'base' | 'target'): string {
    const normalized = normalizeCurrency(value);
    if (!isSupportedCurrency(normalized)) {
      throw new BadRequestException(`不支持的${field === 'base' ? '基础' : '目标'}货币: ${normalized}`);
    }
    return normalized;
  }

  private validatePeriod(period: number): RatePeriod {
    if (!VALID_PERIODS.includes(period as RatePeriod)) {
      throw new BadRequestException(`period 必须是 ${VALID_PERIODS.join('、')} 之一`);
    }
    return period as RatePeriod;
  }

  /** targets 规范化：缺省 [USD]、去重保序、逐个校验清单内（400） */
  private normalizeTargets(targets?: string[]): string[] {
    if (targets === undefined || targets.length === 0) {
      return ['USD'];
    }
    if (targets.length > SUPPORTED_CURRENCIES.length) {
      throw new BadRequestException(
        `targets 最多支持 ${SUPPORTED_CURRENCIES.length} 个币种`,
      );
    }
    const normalized: string[] = [];
    for (const target of targets) {
      const code = normalizeCurrency(String(target));
      if (!isSupportedCurrency(code)) {
        throw new BadRequestException(`不支持的目标货币: ${code}`);
      }
      if (!normalized.includes(code)) {
        normalized.push(code);
      }
    }
    return normalized;
  }

  /** 每个币对取 observedAt 最新一行（窗口与兑底提示都基于该行） */
  private async findLatestRows(
    base: string,
    quotes: string[],
  ): Promise<Map<string, LatestRow>> {
    const latest = new Map<string, LatestRow>();
    if (quotes.length === 0) return latest;

    const rows = await this.prisma.exchangeRate.findMany({
      where: { base, quote: { in: quotes } },
      orderBy: { observedAt: 'desc' },
    });
    for (const row of rows) {
      if (!latest.has(row.quote)) latest.set(row.quote, row);
    }
    return latest;
  }

  /** 窗口内命中/陈旧回显共用的组构建：行值原样映射，绝不触碰行（不重置窗口） */
  private cachedGroup(
    requested: string[],
    rows: Map<string, LatestRow>,
  ): GroupResult {
    const group: GroupResult = new Map();
    for (const target of requested) {
      const row = rows.get(target)!;
      group.set(target, {
        rate: row.rate.toString(),
        ...(row.sellRate != null ? { sellRate: row.sellRate.toString() } : {}),
        source: row.source,
        observedAt: row.observedAt,
        confirmedAt: row.createdAt,
      });
    }
    return group;
  }

  /**
   * 后台异步回源（SWR 陈旧回显路径专用）：fire-and-forget，失败仅告警不上抛——
   * 响应已用旧值返回，本次失败由下次轮询/进页重试；复用单飞避免与进行中的
   * 同步回源重复外呼。
   */
  private kickBackgroundRefresh(
    base: string,
    requested: string[],
    externalTargets: string[],
    rows: Map<string, LatestRow>,
  ): void {
    void this.refreshWithSingleFlight(
      base,
      requested,
      externalTargets,
      rows,
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `后台汇率回源失败（base=${base}，targets=${requested.join(',')}）：${message}`,
      );
    });
  }

  /** 同键回源单飞：进行中请求复用，结束后清除（方案 §3.3） */
  private refreshWithSingleFlight(
    base: string,
    requested: string[],
    externalTargets: string[],
    rows: Map<string, LatestRow>,
  ): Promise<GroupResult> {
    const key = `${base}|${[...requested].sort().join(',')}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.refreshGroup(
      base,
      requested,
      externalTargets,
      rows,
    ).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * 整组回源：外部币种一次批量外呼（同一时点），恒等币种本地生成；
   * 逐币对 upsert 落库（原值 rate + createdAt 刷新 = 窗口重置）。
   */
  private async refreshGroup(
    base: string,
    requested: string[],
    externalTargets: string[],
    rows: Map<string, LatestRow>,
  ): Promise<GroupResult> {
    const confirmedAt = new Date();
    const results: GroupResult = new Map();
    const groupObservedAt = await this.refreshExternalTargets(
      base,
      requested,
      externalTargets,
      rows,
      confirmedAt,
      results,
    );

    // 恒等项（target === base）：数学事实，本地生成不外呼；落库方式与普通报价一致
    for (const target of requested) {
      if (target !== base || results.has(target)) continue;
      results.set(
        target,
        await this.persistQuote({
          base,
          target,
          rate: '1',
          source: IDENTITY_RATE_SOURCE,
          observedAt: groupObservedAt ?? confirmedAt,
          confirmedAt,
        }),
      );
    }
    return results;
  }

  /**
   * 外部币种回源：一次批量外呼，逐币对落库或标记项级错误；返回组报价时点。
   * 单目标错误以 HTTP 语义上抛（422 / 502）；多目标错误下沉到项，不拖垮同组。
   */
  private async refreshExternalTargets(
    base: string,
    requested: string[],
    externalTargets: string[],
    rows: Map<string, LatestRow>,
    confirmedAt: Date,
    results: GroupResult,
  ): Promise<Date | undefined> {
    if (externalTargets.length === 0) return undefined;

    let groupObservedAt: Date | undefined;
    try {
      const batch = await this.provider.fetchLatestBatch(base, externalTargets);
      for (const target of externalTargets) {
        // 多源部分失败：该源币对 502 下沉，不拖垮同组其余币对
        const failure = batch.failures?.[target];
        if (failure !== undefined) {
          results.set(
            target,
            this.toGroupError(
              base,
              target,
              failure,
              rows.get(target)?.observedAt ?? null,
            ),
          );
          continue;
        }
        const quote = batch.quotes[target];
        if (quote === undefined) {
          // 数据源应答正常但缺该目标币种（如 ECB 无 TWD）：标记不支持，不拖垮同组
          results.set(target, this.unsupportedError(base, target));
          continue;
        }
        groupObservedAt ??= quote.observedAt;
        results.set(
          target,
          await this.persistQuote({
            base,
            target,
            rate: quote.rate,
            ...(quote.sellRate !== undefined ? { sellRate: quote.sellRate } : {}),
            source: batch.sources?.[target] ?? batch.source,
            observedAt: quote.observedAt,
            confirmedAt,
          }),
        );
      }
    } catch (error) {
      if (
        error instanceof RatePairUnsupportedException &&
        externalTargets.length > 1
      ) {
        // 数据源对含任一未知币种的批量请求整批 404，无法定位坏目标 →
        // 降级逐个单查：坏币种标记 422，好币种照常落库，不拖垮同组
        await Promise.all(
          externalTargets.map((target) =>
            this.refreshSingleExternal(base, target, rows, confirmedAt, results),
          ),
        );
      } else if (requested.length === 1) {
        // 单目标：错误以 HTTP 语义上抛（422 币对不支持 / 502 数据源不可用 + lastObservedAt）
        if (error instanceof RatePairUnsupportedException) {
          throw error;
        }
        throw new RateSourceUnavailableException(
          rows.get(requested[0])?.observedAt ?? null,
        );
      } else {
        // 多目标整批失败：逐项 502 error 下沉（恒等项不受影响，照常返回）
        for (const target of externalTargets) {
          results.set(
            target,
            this.toGroupError(
              base,
              target,
              error,
              rows.get(target)?.observedAt ?? null,
            ),
          );
        }
      }
    }
    return groupObservedAt;
  }

  /** 批量 404 降级后的单目标回源：成功落库，失败标记项级错误（不拖垮同组） */
  private async refreshSingleExternal(
    base: string,
    target: string,
    rows: Map<string, LatestRow>,
    confirmedAt: Date,
    results: GroupResult,
  ): Promise<void> {
    try {
      const quote = await this.provider.fetchLatest(base, target);
      results.set(
        target,
        await this.persistQuote({
          base,
          target,
          rate: quote.rate,
          ...(quote.sellRate !== undefined ? { sellRate: quote.sellRate } : {}),
          source: quote.source,
          observedAt: quote.observedAt,
          confirmedAt,
        }),
      );
    } catch (fallbackError) {
      results.set(
        target,
        this.toGroupError(
          base,
          target,
          fallbackError,
          rows.get(target)?.observedAt ?? null,
        ),
      );
    }
  }

  /**
   * 落库原值；update 分支显式刷新 createdAt = 最后确认时间（窗口重置，仅回源成功发生）。
   * sellRate 仅在有值时写入（create 与 update 同步落 sell_rate 列；缺省不触碰该列，
   * 避免无卖出价的源/恒等报价洗掉同行既有值）。
   */
  private async persistQuote(quote: QuoteToPersist): Promise<LatestQuoteData> {
    const { base, target, rate, sellRate, source, observedAt, confirmedAt } = quote;
    const sellRateField = sellRate !== undefined ? { sellRate } : {};
    const row = await this.prisma.exchangeRate.upsert({
      where: {
        base_quote_observedAt: { base, quote: target, observedAt },
      },
      create: { base, quote: target, rate, source, observedAt, ...sellRateField },
      update: { rate, source, createdAt: confirmedAt, ...sellRateField },
    });
    return {
      rate: row.rate.toString(),
      ...(row.sellRate != null ? { sellRate: row.sellRate.toString() } : {}),
      source: row.source,
      observedAt: row.observedAt,
      confirmedAt: row.createdAt,
    };
  }

  private unsupportedError(base: string, target: string): LatestQuoteError {
    return {
      code: 'RATE_PAIR_UNSUPPORTED',
      message: `汇率数据源不支持 ${base} → ${target} 报价，无法提供该币种有效报价`,
      lastObservedAt: null,
    };
  }

  private toGroupError(
    base: string,
    target: string,
    error: unknown,
    lastObservedAt: Date | null,
  ): LatestQuoteError {
    if (error instanceof RatePairUnsupportedException) {
      return this.unsupportedError(base, target);
    }
    return {
      code: 'RATE_SOURCE_UNAVAILABLE',
      message: lastObservedAt
        ? `汇率数据源暂时不可用，最后有效报价时间为 ${lastObservedAt.toISOString()}，请稍后重试`
        : '汇率数据源暂时不可用，请稍后重试',
      lastObservedAt: lastObservedAt ? lastObservedAt.toISOString() : null,
    };
  }

  /** 组装响应项：rate/sellRate 用 money 包 roundRateTo8 输出 8 位（库中原值保留）；sellRate 缺省时不下发该字段 */
  private toItem(
    target: string,
    entry: LatestQuoteData | LatestQuoteError,
  ): LatestRateItem {
    if ('code' in entry) {
      return { target, error: entry };
    }
    const validUntil = new Date(entry.confirmedAt.getTime() + QUOTE_TTL_MS);
    return {
      target,
      rate: roundRateTo8(entry.rate).toString(),
      ...(entry.sellRate !== undefined
        ? { sellRate: roundRateTo8(entry.sellRate).toString() }
        : {}),
      source: entry.source,
      observedAt: entry.observedAt.toISOString(),
      validUntil: validUntil.toISOString(),
      fresh: Date.now() < validUntil.getTime(),
    };
  }

  private localHistory(start: Date, end: Date): RateHistoryPoint[] {
    return [{ rate: '1', observedAt: end >= start ? end : start }];
  }

  private startOfUtcDay(value: Date): Date {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }

  private formatDate(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private toHistoryResponse(
    base: string,
    target: string,
    period: RatePeriod,
    rates: Array<{
      rate: { toString(): string };
      observedAt: Date;
    }>,
  ) {
    const dataPoints = rates.map((rate) => ({
      date: rate.observedAt.toISOString().slice(0, 10),
      rate: rate.rate.toString(),
    }));

    return {
      base,
      target,
      period,
      data_points: dataPoints,
      current_rate: dataPoints.at(-1)?.rate ?? null,
    };
  }
}
