import { randomUUID } from 'node:crypto';
import { roundRateTo8 } from '@fxplanner-new/money';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma, type ExchangeRate } from '@prisma/client';
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
  REFERENCE_RATE_SOURCE,
  SUPPORTED_CURRENCIES,
  VALID_PERIODS,
  type RatePeriod,
} from './rate.constants';
import {
  RatePairUnsupportedException,
  RateSourceUnavailableException,
} from './rate.errors';
import { RateProvider, type RateHistoryPoint } from './rate.provider';

interface HistoryRow {
  rate: { toString(): string };
  observedAt: Date;
  source?: string;
}

/** 项级报价数据：confirmedAt 为最新确认时间，历史行只可陈旧回显 */
interface LatestQuoteData {
  rate: string;
  /** 现汇卖出价（仅 abc 源有值；缺省 = 无卖出价，录入场景回退 rate） */
  sellRate?: string;
  source: string;
  observedAt: Date;
  confirmedAt: Date | null;
}

/** 常量行查价 raw SQL 投影 */
interface LatestQuoteSqlRow {
  id: string;
  base: string;
  quote: string;
  rate: { toString(): string };
  sellRate: { toString(): string } | null;
  source: string;
  observedAt: Date;
  latestConfirmedAt: Date | null;
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
  /** 现汇卖出价（仅 ABC 源；缺省时保留同键已有的 ABC 卖出价） */
  sellRate?: string;
  source: string;
  observedAt: Date;
  confirmedAt: Date;
}

type GroupResult = Map<string, LatestQuoteData | LatestQuoteError>;
type LatestQuoteMode = 'swr' | 'fresh-only' | 'force-refresh';

/** ABC 和恒等源的历史口径已知，其余行须有当前行版本的回源或迁移证据。 */
const ABC_SOURCE = 'abc';
const NATIVE_DIRECTION_SOURCES = [ABC_SOURCE, IDENTITY_RATE_SOURCE];
const TRUSTED_DIRECTION: Prisma.ExchangeRateWhereInput = {
  OR: [
    { source: { in: NATIVE_DIRECTION_SOURCES } },
    { canonicalWriteId: { not: null } },
    { migrationOwnerId: { not: null } },
  ],
};

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
  /**
   * 参考序列（frankfurter v2）缓存：币对+区间 → { points, expiresAt }（MVP-F0-2 C2）。
   * 成功与失败均登记 TTL：日级参考数据无 DB 落库层，缓存是防外呼放大的唯一闸门；
   * 区间入键实现「同币对不同窗口按范围隔离」。
   */
  private readonly referenceCache = new Map<
    string,
    { points: RateHistoryPoint[]; expiresAt: number }
  >();
  /** 参考序列单飞：同币对同区间的进行中 fetchReferenceSeries 被并发请求复用 */
  private readonly referenceInFlight = new Map<
    string,
    Promise<RateHistoryPoint[]>
  >();

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
   * - 窗口基准为最新取价确认时间 latestConfirmedAt，历史回补和缓存读取不刷新窗口；
   * - 仅已确认且 now < latestConfirmedAt + 5min 的报价为 fresh；
   * - 同币种恒等报价 rate="1" 本地生成不外呼；
   * - refresh=false 以八位精度下仍为正数的缓存报价执行三档决策（changes/rate-stale-echo-fix/技术方案.md §3.1）：
   *   ① 全部目标窗口内 → 命中返回；② 全部目标有行但超窗 → 立即回显旧值
   *   （fresh=false 如实标注）+ 后台异步单飞回源（失败仅告警不上抛）；
   *   ③ 任一目标无行（冷启动）→ 同步回源；
   * - refresh=true 或冷启动路径：整组一次外呼（同一时点），错误逐项下沉或按单目标上抛。
   */
  async getLatest(base: string, targets?: string[], refresh = false) {
    return this.loadLatest(base, targets, refresh ? 'force-refresh' : 'swr');
  }

  /** 入账取价：复用新鲜缓存，过期或缺失时等待一次整组回源。 */
  async getLatestForBooking(base: string, targets: string[]) {
    return this.loadLatest(base, targets, 'fresh-only');
  }

  private async loadLatest(
    base: string,
    targets: string[] | undefined,
    mode: LatestQuoteMode,
  ) {
    const normalizedBase = this.validateCurrency(base, 'base');
    const requested = this.normalizeTargets(targets);
    const externalTargets = requested.filter((target) => target !== normalizedBase);

    const cached = await this.findLatestPublishableQuotes(
      normalizedBase,
      requested,
    );
    const now = Date.now();
    const allFresh = requested.every((target) => {
      const confirmedAt = cached.get(target)?.confirmedAt;
      return confirmedAt != null && now < confirmedAt.getTime() + QUOTE_TTL_MS;
    });

    let group: GroupResult;
    if (mode !== 'force-refresh' && allFresh) {
      group = cached;
    } else if (mode === 'swr' && requested.every((target) => cached.has(target))) {
      // SWR 陈旧回显：库内齐但超窗 → 先用旧值响应（不阻塞），后台异步回源落库；
      // 回源成功刷新最新确认时间，前端轮询可拿到新值。
      group = cached;
      this.kickBackgroundRefresh(
        normalizedBase,
        requested,
        externalTargets,
        cached,
      );
    } else {
      group = await this.refreshWithSingleFlight(
        normalizedBase,
        requested,
        externalTargets,
        cached,
      );
    }

    const resolveGroupItem = (target: string) => {
      const resolved = group.get(target);
      if (!resolved) {
        throw new Error(`汇率分组结果缺失目标币种：${target}`);
      }
      return this.toItem(target, resolved);
    };

    if (requested.length === 1) {
      // 单目标：组内错误项以 HTTP 语义上抛（422 币对不支持 / 502 数据源不可用）
      const item = resolveGroupItem(requested[0]);
      if (!('rate' in item)) {
        throw item.error.code === 'RATE_PAIR_UNSUPPORTED'
                ? new RatePairUnsupportedException(normalizedBase, requested[0])
                : new RateSourceUnavailableException(item.error.lastObservedAt);
      }
      return { base: normalizedBase, ...item } satisfies LatestRateResponse;
    }
    return {
      base: normalizedBase,
      items: requested.map((target) => resolveGroupItem(target)),
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
   * - 本地皆无则按当前路由源 fetchHistory 回补当日历史后重查（保留方向已证的同行；
   *   er-api 免费档无历史端点返回空数组，回补只对具备真实历史的源产生可用行）；
   * - 仍无 → 返回 null，上层抛 400 RATE_QUOTE_UNAVAILABLE。严禁伪造 observedAt。
   * 方向与采用价口径与 onboarding 取价一致（sellRate ?? rate，1 外币 = X 本位币）。
   */
  async findQuoteAt(
    baseCurrency: string,
    currencyCode: string,
    at: Date,
    { backfill = true }: { backfill?: boolean } = {},
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
          ...TRUSTED_DIRECTION,
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
          ...TRUSTED_DIRECTION,
          observedAt: { gte: lookbackStart, lte: at },
        },
        orderBy: { observedAt: 'desc' },
      });

    let row = await findRealtime();
    if (!row) {
      row = await findDaily();
    }
    if (!row && backfill) {
      // 本地无合格报价：回补当日历史后重查（与 getHistory 同一落库通道）
      const dayStart = utc8DayStart(at);
      try {
        const fetched = await this.provider.fetchHistory(
          baseCurrency,
          currencyCode,
          this.formatDate(dayStart),
          this.formatDate(at),
        );
        await this.persistHistory(baseCurrency, currencyCode, fetched);
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
    const isIdentity = normalizedBase === normalizedTarget;
    const routedSource = isIdentity
      ? IDENTITY_RATE_SOURCE
      : this.provider.sourceForPair(normalizedBase, normalizedTarget);
    const usesReferenceLayer = routedSource === 'er-api';
    const now = new Date();
    const end = this.startOfUtcDay(now);
    const start = new Date(end.getTime() - normalizedPeriod * 86_400_000);

    // ErApi 快照有真实观测时刻。日期窗口含今天，库查到请求时刻为止。
    const historyQuery = {
      where: {
        base: normalizedBase,
        quote: normalizedTarget,
        ...TRUSTED_DIRECTION,
        observedAt: { gte: start, lte: usesReferenceLayer ? now : end },
      },
      orderBy: { observedAt: 'asc' as const },
    };
    const cached = await this.prisma.exchangeRate.findMany(historyQuery);

    if (
      cached.length > 0 &&
      (isIdentity || this.isHistoryCacheComplete(cached, start, end))
    ) {
      return this.toHistoryResponse(
        normalizedBase,
        normalizedTarget,
        normalizedPeriod,
        usesReferenceLayer ? this.mergeReferencePoints(cached, []) : cached,
      );
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
    if (isIdentity) {
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

    await this.persistHistory(normalizedBase, normalizedTarget, fetched);

    const saved = await this.prisma.exchangeRate.findMany(historyQuery);
    const savedComplete = this.isHistoryCacheComplete(saved, start, end);

    // 负缓存登记：真实回源后仍不完整的币对（含回源为空序列的数据源）→
    // 10 分钟内不再重试回源（方案 §6）；负缓存命中路径不刷新窗口，
    // 保证窗口期满必然重新尝试。恒等币对本地生成不外呼，不参与登记。
    if (
      !isIdentity &&
      !negativeCached &&
      !savedComplete
    ) {
      this.historyNegativeCache.set(
        pairKey,
        Date.now() + HISTORY_NEGATIVE_CACHE_TTL_MS,
      );
    }

    // 参考层（MVP-F0-2 C2·TWD 图表）：er-api 路由币对（TWD）本地序列不完整时，
    // 用 frankfurter v2 日级参考序列在【响应合并层】补点——严禁回写 exchange_rates
    //（参考点不占现行键、不刷新 createdAt、不出现在最新/原时点报价候选中）。
    // 其余源（abc/frankfurter/identity）维持原行为（v1-only 回归保留）。
    let reference: RateHistoryPoint[] = [];
    if (usesReferenceLayer && !savedComplete) {
      reference = await this.fetchReferencePoints(
        pairKey,
        normalizedBase,
        normalizedTarget,
        start,
        end,
      );
    }

    return this.toHistoryResponse(
      normalizedBase,
      normalizedTarget,
      normalizedPeriod,
      usesReferenceLayer ? this.mergeReferencePoints(saved, reference) : saved,
    );
  }

  /** 每个 UTC 日期优先保留最后观测的本地行，其次使用 v2 日级参考点。 */
  private mergeReferencePoints(
    localPoints: HistoryRow[],
    reference: RateHistoryPoint[],
  ): HistoryRow[] {
    const byDate = new Map<string, HistoryRow>();
    // v2 仅提供日期。同日冲突取归一化汇率的十进制较小值。
    for (const point of reference) {
      const date = this.formatDate(point.observedAt);
      const previous = byDate.get(date);
      if (!previous || new Prisma.Decimal(point.rate).lt(previous.rate.toString())) {
        byDate.set(date, { ...point, source: REFERENCE_RATE_SOURCE });
      }
    }
    // 本地查询按 observedAt 升序，最新快照覆盖同日参考点及更早的本地快照。
    for (const point of localPoints) {
      byDate.set(this.formatDate(point.observedAt), point);
    }
    return [...byDate.values()].sort(
      (left, right) => left.observedAt.getTime() - right.observedAt.getTime(),
    );
  }

  /**
   * 参考层合并守卫：区间级缓存（成功/失败均登记 TTL，防外呼放大）+ 区间级单飞；
   * 参考序列获取失败不阻断图表（按「无参考点」返回本地序列，冷缺口如实披露）。
   */
  private async fetchReferencePoints(
    pairKey: string,
    base: string,
    target: string,
    start: Date,
    end: Date,
  ): Promise<RateHistoryPoint[]> {
    const rangeKey = `${pairKey}|${this.formatDate(start)}|${this.formatDate(end)}`;
    // 日期滚动后旧区间不再被查询，读取任一区间时统一淘汰过期条目。
    const now = Date.now();
    for (const [key, entry] of this.referenceCache) {
      if (entry.expiresAt <= now) this.referenceCache.delete(key);
    }
    const cached = this.referenceCache.get(rangeKey);
    if (cached) {
      return cached.points;
    }

    let promise = this.referenceInFlight.get(rangeKey);
    if (!promise) {
      promise = this.provider
        .fetchReferenceSeries(
          base,
          target,
          this.formatDate(start),
          this.formatDate(end),
        )
        .catch((error: unknown): RateHistoryPoint[] => {
          // 参考源不可用：不阻断图表，登记负缓存窗口（与 v1 同 TTL）
          this.logger.debug(
            `参考序列获取失败（${rangeKey}），窗口内按无参考点返回本地序列`,
            error instanceof Error ? error.message : error,
          );
          return [];
        })
        .then((points) => {
          // 在清除单飞前发布缓存，避免并发请求在交接时重复回源。
          this.referenceCache.set(rangeKey, {
            points,
            expiresAt: Date.now() + HISTORY_NEGATIVE_CACHE_TTL_MS,
          });
          return points;
        })
        .finally(() => {
          this.referenceInFlight.delete(rangeKey);
        });
      this.referenceInFlight.set(rangeKey, promise);
    }

    return promise;
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

    /** 优先选择最近观测的已确认、可发布报价。历史点仅用于陈旧回显。 */
  private async findLatestPublishableQuotes(
    base: string,
    quotes: string[],
  ): Promise<Map<string, LatestQuoteData>> {
    const latest = new Map<string, LatestQuoteData>();
    const uniqueQuotes = [...new Set(quotes)];
    if (uniqueQuotes.length === 0) return latest;

    // 每目标币种按两档索引扫描上限 1 行（确认层优先，缺失时回退未确认历史层），
    // 并去掉外层 Sort 以保留 Append -> Limit -> Index Scan Backward 短路执行计划。
    const rows = await this.prisma.$queryRaw<LatestQuoteSqlRow[]>(Prisma.sql`
      SELECT
        r.id,
        r.base,
        r.quote,
        r.rate,
        r.sell_rate AS "sellRate",
        r.source,
        r.observed_at AS "observedAt",
        r.latest_confirmed_at AS "latestConfirmedAt"
      FROM unnest(${uniqueQuotes}::text[]) AS q(quote)
      CROSS JOIN LATERAL (
        (
          SELECT id, base, quote, rate, sell_rate, source, observed_at, latest_confirmed_at
          FROM exchange_rates
          WHERE base = ${base}
            AND quote = q.quote
            AND latest_confirmed_at IS NOT NULL
            AND (
              source = ANY(${NATIVE_DIRECTION_SOURCES}::text[])
              OR canonical_write_id IS NOT NULL
              OR migration_owner_id IS NOT NULL
            )
            AND rate >= 0.000000005
            AND (sell_rate IS NULL OR sell_rate >= 0.000000005)
          ORDER BY observed_at DESC
          LIMIT 1
        )
        UNION ALL
        (
          SELECT id, base, quote, rate, sell_rate, source, observed_at, latest_confirmed_at
          FROM exchange_rates
          WHERE base = ${base}
            AND quote = q.quote
            AND latest_confirmed_at IS NULL
            AND (
              source = ANY(${NATIVE_DIRECTION_SOURCES}::text[])
              OR canonical_write_id IS NOT NULL
              OR migration_owner_id IS NOT NULL
            )
            AND rate >= 0.000000005
            AND (sell_rate IS NULL OR sell_rate >= 0.000000005)
          ORDER BY observed_at DESC
          LIMIT 1
        )
        LIMIT 1
      ) r
    `);
    for (const row of rows) {
      const selected = latest.get(row.quote);
      if (selected !== undefined &&
          (selected.confirmedAt !== null || row.latestConfirmedAt === null)) continue;
      const prices = this.publishablePrices(
        row.rate.toString(),
        row.sellRate?.toString(),
      );
      if (prices === undefined) continue;
      latest.set(row.quote, {
        ...prices,
        source: row.source,
        observedAt: row.observedAt,
        confirmedAt: row.latestConfirmedAt,
      });
    }
    return latest;
  }

  /** 发布精度为 8 位 HALF_UP，每个报价字段舍入后都须为有限正数。 */
  private publishablePrices(
    rate: string,
    sellRate?: string,
  ): Pick<LatestQuoteData, 'rate' | 'sellRate'> | undefined {
    const roundedRate = roundRateTo8(rate);
    if (!roundedRate.isFinite() || !roundedRate.gt(0)) return undefined;
    if (sellRate === undefined) return { rate: roundedRate.toString() };

    const roundedSellRate = roundRateTo8(sellRate);
    if (!roundedSellRate.isFinite() || !roundedSellRate.gt(0)) return undefined;
    return { rate: roundedRate.toString(), sellRate: roundedSellRate.toString() };
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
    cached: Map<string, LatestQuoteData>,
  ): void {
    void this.refreshWithSingleFlight(
      base,
      requested,
      externalTargets,
      cached,
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
    cached: Map<string, LatestQuoteData>,
  ): Promise<GroupResult> {
    const key = `${base}|${[...requested].sort().join(',')}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.refreshGroup(
      base,
      requested,
      externalTargets,
      cached,
    ).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * 整组回源：外部币种一次批量外呼（同一时点），恒等币种本地生成；
   * 逐币对 upsert 同时写入原始报价与最新确认时间。
   */
  private async refreshGroup(
    base: string,
    requested: string[],
    externalTargets: string[],
    cached: Map<string, LatestQuoteData>,
  ): Promise<GroupResult> {
    const results: GroupResult = new Map();
    const groupObservedAt = await this.refreshExternalTargets(
      base,
      requested,
      externalTargets,
      cached,
      results,
    );

    // 恒等项（target === base）：数学事实，本地生成不外呼；落库方式与普通报价一致
    const confirmedAt = new Date();
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
    cached: Map<string, LatestQuoteData>,
    results: GroupResult,
  ): Promise<Date | undefined> {
    if (externalTargets.length === 0) return undefined;

    let groupObservedAt: Date | undefined;
    try {
      const batch = await this.provider.fetchLatestBatch(base, externalTargets);
      const confirmedAt = new Date();
      for (const target of externalTargets) {
        const lastObservedAt = cached.get(target)?.observedAt ?? null;
        // 多源部分失败：该源币对 502 下沉，不拖垮同组其余币对
        const failure = batch.failures?.[target];
        if (failure !== undefined) {
          results.set(
            target,
            this.toGroupError(
              base,
              target,
              failure,
              lastObservedAt,
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
        const result = await this.persistQuote(
          {
            base,
            target,
            rate: quote.rate,
            ...(quote.sellRate !== undefined ? { sellRate: quote.sellRate } : {}),
            source: batch.sources?.[target] ?? batch.source,
            observedAt: quote.observedAt,
            confirmedAt,
          },
          lastObservedAt,
        );
        if (!('code' in result)) groupObservedAt ??= result.observedAt;
        results.set(target, result);
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
            this.refreshSingleExternal(base, target, cached, results),
          ),
        );
      } else if (requested.length === 1) {
        // 单目标：错误以 HTTP 语义上抛（422 币对不支持 / 502 数据源不可用 + lastObservedAt）
        if (error instanceof RatePairUnsupportedException) {
          throw error;
        }
        throw new RateSourceUnavailableException(
          cached.get(requested[0])?.observedAt ?? null,
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
              cached.get(target)?.observedAt ?? null,
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
    cached: Map<string, LatestQuoteData>,
    results: GroupResult,
  ): Promise<void> {
    const lastObservedAt = cached.get(target)?.observedAt ?? null;
    try {
      const quote = await this.provider.fetchLatest(base, target);
      results.set(
        target,
        await this.persistQuote(
          {
            base,
            target,
            rate: quote.rate,
            ...(quote.sellRate !== undefined ? { sellRate: quote.sellRate } : {}),
            source: quote.source,
            observedAt: quote.observedAt,
            confirmedAt: new Date(),
          },
          lastObservedAt,
        ),
      );
    } catch (fallbackError) {
      results.set(
        target,
        this.toGroupError(
          base,
          target,
          fallbackError,
          lastObservedAt,
        ),
      );
    }
  }

  /**
   * 最新取价成功时同时写入原值与确认时间，保留首次入库时间。
   * ABC 缺省卖出价时仅保留同源同行的卖出价。其他来源刷新时清除历史同行的卖出价。
   */
  private async persistQuote(
    quote: QuoteToPersist,
    lastObservedAt: Date | null = null,
  ): Promise<LatestQuoteData | LatestQuoteError> {
    const { base, target, rate, sellRate, source, observedAt, confirmedAt } = quote;
    if (this.publishablePrices(rate, sellRate) === undefined) {
      return this.unavailableError(lastObservedAt);
    }
    const canonicalWriteId = randomUUID();
    const where = { base_quote_observedAt: { base, quote: target, observedAt } };
    const create = {
      base, quote: target, rate, source, observedAt, canonicalWriteId,
      latestConfirmedAt: confirmedAt, ...(sellRate !== undefined ? { sellRate } : {}),
    };
    const toPublishable = (row: Pick<ExchangeRate, 'rate' | 'sellRate' | 'source' | 'observedAt' | 'latestConfirmedAt'>): LatestQuoteData => {
      const prices = this.publishablePrices(row.rate.toString(), row.sellRate?.toString());
      if (prices === undefined) throw new RateSourceUnavailableException(lastObservedAt);
      return {
        ...prices,
        source: row.source,
        observedAt: row.observedAt,
        confirmedAt: row.latestConfirmedAt,
      };
    };
    try {
      if (source === ABC_SOURCE && sellRate === undefined) {
        return await this.prisma.$transaction(async (tx) => {
          const inserted = await tx.exchangeRate.createMany({ data: create, skipDuplicates: true });
          if (inserted.count === 1) {
            return toPublishable(await tx.exchangeRate.findUniqueOrThrow({ where }));
          }

          // 保留同源卖出价时，在写事务提交前验证发布精度。
          const [updated] = await tx.$queryRaw<Array<Pick<ExchangeRate, 'rate' | 'sellRate' | 'source' | 'observedAt' | 'latestConfirmedAt'>>>`
            UPDATE "exchange_rates"
            SET "rate" = ${rate}::decimal(20,10), "source" = ${source},
                "latest_confirmed_at" = ${confirmedAt.toISOString()}::timestamp(3),
                "canonical_write_id" = ${canonicalWriteId}::uuid,
                "sell_rate" = CASE WHEN "source" = ${ABC_SOURCE} THEN "sell_rate" ELSE NULL END
            WHERE "base" = ${base} AND "quote" = ${target}
              AND "observed_at" = ${observedAt.toISOString()}::timestamp(3)
            RETURNING "rate", "sell_rate" AS "sellRate", "source",
                      "observed_at" AS "observedAt", "latest_confirmed_at" AS "latestConfirmedAt"
          `;
          return toPublishable(updated ?? await tx.exchangeRate.create({ data: create }));
        });
      }

      return toPublishable(await this.prisma.exchangeRate.upsert({
        where,
        create,
        update: {
          rate, source, latestConfirmedAt: confirmedAt, canonicalWriteId,
          sellRate: sellRate ?? null,
        },
      }));
    } catch (error) {
      if (error instanceof RateSourceUnavailableException) {
        return this.unavailableError(lastObservedAt);
      }
      throw error;
    }
  }

  /** 用同键新报价修复未知方向的行。可信的同行仍沿用历史回补的跳过语义。 */
  private async persistHistory(
    base: string,
    quote: string,
    points: RateHistoryPoint[],
  ): Promise<void> {
    if (points.length === 0) return;
    const source = base === quote
      ? IDENTITY_RATE_SOURCE
      : this.provider.sourceForPair(base, quote);
    const canonicalWriteId = randomUUID();
    const rates = new Map<number, string>();
    for (const { observedAt, rate } of points) {
      const time = observedAt.getTime();
      if (!rates.has(time)) rates.set(time, rate);
    }
    const data = [...rates]
      .sort(([a], [b]) => a - b)
      .map(([time, rate]) => ({
        base, quote, rate, source, observedAt: new Date(time), canonicalWriteId,
      }));

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.exchangeRate.createMany({ data, skipDuplicates: true });
      if (count === data.length) return;

      // 冲突行按最新行版本重新检查资格。一次批量更新覆盖 365 天档，避免逐行往返。
      const replacements = data.map(({ observedAt, rate }) =>
        Prisma.sql`(${observedAt.toISOString()}::timestamp(3), ${rate}::decimal(20,10))`,
      );
      await tx.$executeRaw`
        UPDATE "exchange_rates" AS cached
        SET "rate" = incoming.rate, "sell_rate" = NULL, "source" = ${source},
            "canonical_write_id" = ${canonicalWriteId}::uuid, "latest_confirmed_at" = NULL
        FROM (VALUES ${Prisma.join(replacements)}) AS incoming(observed_at, rate)
        WHERE cached.base = ${base} AND cached.quote = ${quote}
          AND cached.observed_at = incoming.observed_at
          AND cached.canonical_write_id IS NULL AND cached.migration_owner_id IS NULL
          AND cached.source NOT IN (${Prisma.join(NATIVE_DIRECTION_SOURCES)})
      `;
    });
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
    return this.unavailableError(lastObservedAt);
  }

  private unavailableError(lastObservedAt: Date | null): LatestQuoteError {
    return {
      code: 'RATE_SOURCE_UNAVAILABLE',
      message: lastObservedAt
        ? `汇率数据源暂时不可用，最后有效报价时间为 ${lastObservedAt.toISOString()}，请稍后重试`
        : '汇率数据源暂时不可用，请稍后重试',
      lastObservedAt: lastObservedAt ? lastObservedAt.toISOString() : null,
    };
  }

  private toItem(
    target: string,
    entry: LatestQuoteData | LatestQuoteError,
  ): LatestRateItem {
    if ('code' in entry) {
      return { target, error: entry };
    }
    // 历史行没有有效期，使用已过期的固定时间维持 validUntil 的 ISO 日期契约。
    const validUntil = new Date(
      entry.confirmedAt ? entry.confirmedAt.getTime() + QUOTE_TTL_MS : 0,
    );
    return {
      target,
      rate: entry.rate,
      ...(entry.sellRate !== undefined ? { sellRate: entry.sellRate } : {}),
      source: entry.source,
      observedAt: entry.observedAt.toISOString(),
      validUntil: validUntil.toISOString(),
      fresh: entry.confirmedAt !== null && Date.now() < validUntil.getTime(),
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
    rates: HistoryRow[],
  ) {
    // 逐点来源标注（MVP-F0-2 C2）：行情/AI 历史工具据此区分参考价与原来源；
    // 参考点 source = frankfurter-v2-reference，本地行 source = 落库数据源标识
    const dataPoints = rates.map((rate) => ({
      date: rate.observedAt.toISOString().slice(0, 10),
      rate: rate.rate.toString(),
      ...(rate.source !== undefined ? { source: rate.source } : {}),
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
