import { describe, expect, it } from "vitest";
import { isProductionBackfillTarget } from "./organization-backfill";

/**
 * MIG-B 写入的生产目标拒绝（评审 I-15；技术方案 §12.4）。
 * 连接串均为无凭据的占位样本。
 */
describe("isProductionBackfillTarget", () => {
	it("库名匹配大小写不敏感：此前 /fxplanner_prod/ 漏放 FXPLANNER_PROD", () => {
		for (const url of [
			"postgresql://db-host:5432/fxplanner_prod",
			"postgresql://db-host:5432/FXPLANNER_PROD",
			"postgresql://db-host:5432/FxPlanner_Prod?schema=public",
		]) {
			expect(isProductionBackfillTarget(url), url).toBe(true);
		}
	});

	it("误伤方向可接受：疑似生产的副本/备份库名同样拒绝", () => {
		for (const url of [
			"postgresql://db-host:5432/fxplanner_prod_backup",
			"postgresql://db-host:5432/restore_of_fxplanner_prod_20261123",
		]) {
			expect(isProductionBackfillTarget(url), url).toBe(true);
		}
	});

	it("NODE_ENV=production：即便库名不像生产也拒绝", () => {
		expect(
			isProductionBackfillTarget(
				"postgresql://db-host:5432/fxplanner_new_db",
				"production",
			),
		).toBe(true);
	});

	it("本地/演练库不误伤", () => {
		for (const [url, nodeEnv] of [
			["postgresql://db-host:5432/fxplanner_new_db_local", undefined],
			["postgresql://db-host:5432/fxplanner_new_db_migbak", "test"],
			["postgresql://db-host:5432/fxplanner_review_4db3_w6_stack_r1", "development"],
		] as const) {
			expect(isProductionBackfillTarget(url, nodeEnv), url).toBe(false);
		}
	});
});
