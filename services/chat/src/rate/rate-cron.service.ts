import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { SUPPORTED_CURRENCIES } from "./rate.constants";
import { type LatestRateItem, RateService } from "./rate.service";

/** 单轮刷新摘要：runOnce 承诺不抛异常，逃逸异常收敛进 fatal（rate-refresh-cron 技术方案 §3.2） */
export interface CronRunSummary {
	triggeredAt: string;
	succeeded: string[];
	failed: { target: string; code: string }[];
	/** 仅 getLatest 整体逃逸异常时出现（如恒等项 persistQuote 的 DB 故障），出现即整轮未执行成功 */
	fatal?: string;
}

/** 开关注入 token（rate.module 注册，读 env.RATE_CRON_ENABLED；缺省开启） */
export const RATE_CRON_ENABLED_TOKEN = "RATE_CRON_ENABLED";

/**
 * 汇率定时刷新（rate-refresh-cron 技术方案 §3.2）：
 * 每整点、每半点按 CNY 视角强制回源 15 币种并落库，复用 RateService.getLatest
 * 既有链路（多源路由 / 单源失败下沉 / upsert 去重），rate.service.ts 零改动。
 * 失败不打扰用户：项级失败进摘要 failed，逃逸异常进 fatal，轮次永不中断进程。
 */
@Injectable()
export class RateCronService {
	private readonly logger = new Logger(RateCronService.name);

	constructor(
		@Inject(RateService) private readonly rateService: RateService,
		@Inject(RATE_CRON_ENABLED_TOKEN) private readonly enabled: boolean,
	) {}

	/** 整点 + 半点各一轮：EVERY_30_MINUTES（每 0/30 分触发），时区无关，语义全球一致 */
	@Cron(CronExpression.EVERY_30_MINUTES)
	async handleCron(): Promise<void> {
		if (!this.enabled) return; // RATE_CRON_ENABLED=false（含 vitest test.env 注入）时静默跳过
		// runOnce 承诺不抛；此 catch 仅防御实现缺陷，保证轮次永不中断后续调度
		await this.runOnce().catch((error: unknown) =>
			this.logger.warn(
				`汇率定时刷新轮次异常兜底：${(error as Error).message}`,
			),
		);
	}

	/** 单轮刷新：定时与手动触发（POST /rates/cron-refresh）共用，等价一轮定时任务 */
	async runOnce(): Promise<CronRunSummary> {
		const triggeredAt = new Date().toISOString();
		try {
			// 强制回源（refresh=true）绕过 5 分钟窗口；多目标错误下沉 items 不抛（规格 §3.4）
			const res = await this.rateService.getLatest(
				"CNY",
				[...SUPPORTED_CURRENCIES],
				true,
			);
			// 防御：getLatest 返回单/多目标的匿名联合类型，in 收窄不可靠，显式结构断言；
			// 多目标调用恒返回 items（rate.service.ts getLatest）
			const items = (res as { items?: LatestRateItem[] }).items;
			if (!Array.isArray(items)) {
				return {
					triggeredAt,
					succeeded: [],
					failed: [],
					fatal: "unexpected response shape: missing items",
				};
			}
			const succeeded: string[] = [];
			const failed: { target: string; code: string }[] = [];
			for (const item of items) {
				if ("error" in item) {
					failed.push({ target: item.target, code: item.error.code });
				} else {
					succeeded.push(item.target);
				}
			}
			this.logger.log(
				`汇率定时刷新完成：成功 ${succeeded.length} 项` +
					(failed.length
						? `，失败 ${failed.map((f) => f.target).join(",")}`
						: ""),
			);
			return { triggeredAt, succeeded, failed };
		} catch (error) {
			// 逃逸路径：恒等项 persistQuote 在 refreshExternalTargets 的 try-catch 之外
			// （rate.service.ts:449），DB 故障时异常直接逃逸 getLatest → 收敛为 fatal，不向上抛。
			// ⚠️ 日志仅记 message，禁止打印完整上游响应体（无敏感数据，防体积噪音）
			const message = (error as Error).message;
			this.logger.warn(`汇率定时刷新整轮失败（fatal）：${message}`);
			return { triggeredAt, succeeded: [], failed: [], fatal: message };
		}
	}
}
