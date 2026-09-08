import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  isSupportedCurrency,
  normalizeCurrency,
  RATE_CACHE_TTL_MS,
  RATE_SOURCE,
  SUPPORTED_CURRENCIES,
  VALID_PERIODS,
  type RatePeriod,
} from './rate.constants';
import { RateProvider, type RateHistoryPoint, type RateQuote } from './rate.provider';

@Injectable()
export class RateService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RateProvider) private readonly provider: RateProvider,
  ) {}

  getSupported(): string[] {
    return [...SUPPORTED_CURRENCIES];
  }

  async getLatest(base: string) {
    const normalizedBase = this.validateCurrency(base, 'base');
    const quote = 'USD';
    const cached = await this.prisma.exchangeRate.findFirst({
      where: { base: normalizedBase, quote },
      orderBy: { observedAt: 'desc' },
    });

    if (cached && this.isFresh(cached.observedAt)) {
      return this.toLatestResponse(cached);
    }

    const fetched =
      normalizedBase === quote
        ? this.localUsdQuote(normalizedBase)
        : await this.provider.fetchLatest(normalizedBase, quote);
    const saved = await this.prisma.exchangeRate.upsert({
      where: {
        base_quote_observedAt: {
          base: normalizedBase,
          quote,
          observedAt: fetched.observedAt,
        },
      },
      create: {
        base: normalizedBase,
        quote,
        rate: fetched.rate,
        source: fetched.source,
        observedAt: fetched.observedAt,
      },
      update: {
        rate: fetched.rate,
        source: fetched.source,
      },
    });

    return this.toLatestResponse(saved);
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

    const fetched =
      normalizedBase === normalizedTarget
        ? this.localHistory(start, end)
        : await this.provider.fetchHistory(
            normalizedBase,
            normalizedTarget,
            this.formatDate(start),
            this.formatDate(end),
          );

    if (fetched.length > 0) {
      await this.prisma.exchangeRate.createMany({
        data: fetched.map((point) => ({
          base: normalizedBase,
          quote: normalizedTarget,
          rate: point.rate,
          source: RATE_SOURCE,
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

    return this.toHistoryResponse(normalizedBase, normalizedTarget, normalizedPeriod, saved);
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

  private isFresh(observedAt: Date): boolean {
    return Date.now() - observedAt.getTime() <= RATE_CACHE_TTL_MS;
  }

  private localUsdQuote(base: string): RateQuote {
    return {
      base,
      quote: 'USD',
      rate: '1',
      source: RATE_SOURCE,
      observedAt: new Date(),
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

  private toLatestResponse(rate: {
    base: string;
    quote: string;
    rate: { toString(): string };
    source: string;
    observedAt: Date;
  }) {
    const value = rate.rate.toString();
    const observedAt = rate.observedAt.toISOString();
    return {
      base: rate.base,
      target: rate.quote,
      quote: rate.quote,
      rate: value,
      rate_to_usd: value,
      source: rate.source,
      observedAt,
      fetched_at: observedAt,
    };
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
