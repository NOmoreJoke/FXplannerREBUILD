import {
  BadGatewayException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { RATE_SOURCE } from './rate.constants';

const FRANKFURTER_BASE_URL = 'https://api.frankfurter.app';
export const RATE_PROVIDER_TIMEOUT_TOKEN = 'RATE_PROVIDER_TIMEOUT_MS';
export const DEFAULT_RATE_PROVIDER_TIMEOUT_MS = 5_000;

type FrankfurterLatestResponse = {
  date?: string;
  rates?: Record<string, string | number>;
};

type FrankfurterHistoryResponse = {
  rates?: Record<string, Record<string, string | number>>;
};

export interface RateQuote {
  base: string;
  quote: string;
  rate: string;
  source: string;
  observedAt: Date;
}

export interface RateHistoryPoint {
  rate: string;
  observedAt: Date;
}

@Injectable()
export class RateProvider {
  constructor(
    @Optional()
    @Inject(RATE_PROVIDER_TIMEOUT_TOKEN)
    timeoutMs?: number,
  ) {
    this.timeoutMs = timeoutMs ?? DEFAULT_RATE_PROVIDER_TIMEOUT_MS;
  }

  private readonly timeoutMs: number;

  async fetchLatest(base: string, target: string): Promise<RateQuote> {
    const response = await this.request<FrankfurterLatestResponse>(
      `${FRANKFURTER_BASE_URL}/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(target)}`,
    );
    const rawRate = response.rates?.[target];

    if (rawRate === undefined) {
      throw new BadGatewayException('汇率供应商未返回目标货币报价');
    }

    return {
      base,
      quote: target,
      rate: String(rawRate),
      source: RATE_SOURCE,
      observedAt: this.parseDate(response.date),
    };
  }

  async fetchHistory(
    base: string,
    target: string,
    start: string,
    end: string,
  ): Promise<RateHistoryPoint[]> {
    const response = await this.request<FrankfurterHistoryResponse>(
      `${FRANKFURTER_BASE_URL}/${encodeURIComponent(start)}..${encodeURIComponent(end)}?from=${encodeURIComponent(base)}&to=${encodeURIComponent(target)}`,
    );

    return Object.entries(response.rates ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([date, rates]) => {
        const rawRate = rates[target];
        if (rawRate === undefined) return [];

        return [{ rate: String(rawRate), observedAt: this.parseDate(date) }];
      });
  }

  private async request<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Frankfurter responded with ${response.status}`);
      }

      return (await response.json()) as T;
    } catch {
      throw new BadGatewayException('汇率供应商暂时不可用');
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseDate(value: string | undefined): Date {
    const date = value ? new Date(`${value}T00:00:00.000Z`) : new Date();
    if (Number.isNaN(date.getTime())) {
      throw new BadGatewayException('汇率供应商返回了无效日期');
    }
    return date;
  }
}
