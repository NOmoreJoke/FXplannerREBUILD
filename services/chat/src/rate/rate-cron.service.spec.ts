import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { SchedulerRegistry, ScheduleModule } from "@nestjs/schedule";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { SUPPORTED_CURRENCIES } from "./rate.constants";
import { RATE_CRON_ENABLED_TOKEN, RateCronService } from "./rate-cron.service";
import { RateService } from "./rate.service";

/**
 * RateCronService 单元测试（rate-refresh-cron 技术方案 §6.1）。
 *
 * onModule（enabled=true，含 ScheduleModule）用于表达式锁定与开启用例；
 * offModule（enabled=false，无调度）用于开关关闭用例。
 * vitest test.env 已注入 RATE_CRON_ENABLED="false"（vitest.config.ts §6.0），
 * 故本文件装配的 RateCronService 开关经 token 显式注入，不受该注入影响。
 */
describe("RateCronService（单元）", () => {
	const getLatest = vi.fn();

	let onModule: TestingModule;
	let onApp: INestApplication;
	let offModule: TestingModule;

	/** 多目标成功/失败混合响应（形状对齐 LatestRateGroupResponse） */
	const groupResponse = (items: unknown[]) => ({ base: "CNY", items });
	const okItem = (target: string) => ({
		target,
		rate: "0.73000000",
		source: "abc",
		observedAt: "2026-09-17T01:00:00.000Z",
		validUntil: "2026-09-17T01:05:00.000Z",
		fresh: true,
	});

	beforeAll(async () => {
		onModule = await Test.createTestingModule({
			imports: [ScheduleModule.forRoot()],
			providers: [
				RateCronService,
				{ provide: RateService, useValue: { getLatest } },
				{ provide: RATE_CRON_ENABLED_TOKEN, useValue: true },
			],
		}).compile();
		// @Cron job 在 onModuleInit（app.init）时才注册进 SchedulerRegistry，
		// 仅 compile 不触发——表达式锁定用例依赖 init 后的注册表
		onApp = await onModule.createNestApplication().init();
		offModule = await Test.createTestingModule({
			providers: [
				RateCronService,
				{ provide: RateService, useValue: { getLatest } },
				{ provide: RATE_CRON_ENABLED_TOKEN, useValue: false },
			],
		}).compile();
	});

	afterAll(async () => {
		await onApp?.close();
		await offModule.close();
	});

	beforeEach(() => {
		getLatest.mockReset();
	});

	it("runOnce 成功轮次：强制回源 CNY×15 币种（refresh=true），摘要归类 succeeded", async () => {
		getLatest.mockResolvedValue(
			groupResponse([okItem("USD"), okItem("TWD"), okItem("MYR")]),
		);

		const summary = await onModule.get(RateCronService).runOnce();

		expect(getLatest).toHaveBeenCalledTimes(1);
		expect(getLatest).toHaveBeenCalledWith(
			"CNY",
			[...SUPPORTED_CURRENCIES],
			true,
		);
		expect(summary.succeeded).toEqual(["USD", "TWD", "MYR"]);
		expect(summary.failed).toEqual([]);
		expect(summary.fatal).toBeUndefined();
	});

	it("runOnce 混合失败：项级 error 归入 failed（含 code），不抛异常", async () => {
		getLatest.mockResolvedValue(
			groupResponse([
				okItem("USD"),
				{
					target: "TWD",
					error: {
						code: "RATE_SOURCE_UNAVAILABLE",
						message: "汇率数据源暂时不可用，请稍后重试",
						lastObservedAt: null,
					},
				},
			]),
		);

		const summary = await onModule.get(RateCronService).runOnce();

		expect(summary.succeeded).toEqual(["USD"]);
		expect(summary.failed).toEqual([
			{ target: "TWD", code: "RATE_SOURCE_UNAVAILABLE" },
		]);
		expect(summary.fatal).toBeUndefined();
	});

	it("runOnce 整体逃逸异常：收敛为 fatal 摘要，方法不向上抛（恒等项 persistQuote DB 故障路径）", async () => {
		getLatest.mockRejectedValue(new Error("db connection lost"));

		const summary = await onModule.get(RateCronService).runOnce();

		expect(summary.succeeded).toEqual([]);
		expect(summary.failed).toEqual([]);
		expect(summary.fatal).toBe("db connection lost");
	});

	it("异常后下一轮继续：首轮 getLatest 抛错后，再次 handleCron 仍发起新一轮调用", async () => {
		getLatest.mockRejectedValueOnce(new Error("first round failed"));
		getLatest.mockResolvedValueOnce(groupResponse([okItem("USD")]));

		const service = onModule.get(RateCronService);
		await service.handleCron();
		await service.handleCron();

		expect(getLatest).toHaveBeenCalledTimes(2);
	});

	it("handleCron 开关关闭：RATE_CRON_ENABLED=false 时静默跳过，不触发回源", async () => {
		await offModule.get(RateCronService).handleCron();

		expect(getLatest).not.toHaveBeenCalled();
	});

	it("handleCron 开关开启：正常执行一轮 runOnce", async () => {
		getLatest.mockResolvedValue(groupResponse([okItem("USD")]));

		await onModule.get(RateCronService).handleCron();

		expect(getLatest).toHaveBeenCalledTimes(1);
	});

	it("cron 表达式锁定：调度器中唯一 job 为 0 */30 * * * *（整点+半点，规格验收①）", () => {
		const registry = onModule.get(SchedulerRegistry);
		const jobs = [...registry.getCronJobs().values()];

		expect(jobs.length).toBe(1);
		// CronTime.source 为构造时的原始表达式字符串（CronExpression.EVERY_30_MINUTES）
		expect(jobs[0].cronTime.source).toBe("0 */30 * * * *");
	});
});
