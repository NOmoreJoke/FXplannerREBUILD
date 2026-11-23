import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSwaggerConfig } from "../../src/config/swagger";
import { createTestApp } from "../helpers/test-app";

type DocumentedOperation = {
	summary?: string;
	description?: string;
};

const HTTP_METHODS = [
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"options",
	"head",
	"trace",
] as const;

describe("Swagger 接口说明", () => {
	let app: INestApplication;

	beforeAll(async () => {
		({ app } = await createTestApp());
	});

	afterAll(async () => {
		await app.close();
	});

	it("所有公开接口都应该包含用途摘要和详细说明", () => {
		const document = SwaggerModule.createDocument(app, createSwaggerConfig());
		const operations = Object.entries(document.paths).flatMap(([path, item]) =>
			HTTP_METHODS.flatMap((method) => {
				const operation = item?.[method] as DocumentedOperation | undefined;
				return operation ? [{ path, method, operation }] : [];
			}),
		);

		// 9 个既有接口 + M0 GET /api/currencies + M1.1 onboarding 3 入口
		// + GET /api/home/state（首页分流状态）
		// + POST /api/plans/schedule-preview、POST /api/plans（创建换汇计划）
		// + POST /api/transactions、GET /api/transactions/:id（买入交易录入）
		// + M5 计划管理 6 端点：GET /api/plans、GET /api/plans/:id、
		//   POST /api/plans/:id/adjust-preview、PATCH /api/plans/:id、
		//   POST /api/plans/:id/complete、POST /api/plans/:id/cancel
		// + M3 外汇账户 3 端点：GET /api/accounts、GET /api/accounts/:currencyCode、
		//   GET /api/accounts/:currencyCode/transactions
		// + GET /api/home/portfolio（首页持仓成本聚合）
		// + onboarding-rework 3 端点：POST /api/onboarding/initial-holdings（补录初始持仓）、
		//   GET /api/settings、PATCH /api/settings（用户设置读写）
		// + 提醒 / 使用记录（M7）/ 更正（M8）/ 数据权利等模块端点（多模块并行追加，计数随模块合入递增）
		// + M10 成本摘要与报告 2 端点：GET /api/reports/plans、GET /api/reports/plans/:id
		// + rate-refresh-cron 1 端点：POST /api/rates/cron-refresh（手动触发定时刷新）
		// + AI 助手 6 端点（ai-assistant §4 + ai-model-whitelist §4.1）：
		//   GET /api/ai/models、GET/POST /api/ai/conversations、
		//   POST/GET /api/ai/conversations/:id/messages、DELETE /api/ai/conversations/:id
		// + 阶段5 §2 账户分配视图 1 端点：GET /api/accounts/:currencyCode/allocations
		// + ToB R1 W17 组织 4 端点 + 审计 1 端点：GET/POST /api/organizations、
		//   GET/PATCH /api/organizations/current、GET /api/organizations/current/audit-logs
		// + ToB R1 W19 成员/邀请 11 端点：GET/PATCH/DELETE /members、POST /members/leave、
		//   POST /transfer-ownership、POST/GET/DELETE /invitations、
		//   GET /organization-invitations/:token、POST accept/decline = 72
		expect(operations).toHaveLength(72);
		for (const { path, method, operation } of operations) {
			expect(
				operation.summary,
				`${method.toUpperCase()} ${path} 缺少 summary`,
			).toBeTypeOf("string");
			expect(operation.summary?.trim().length).toBeGreaterThan(0);
			expect(
				operation.description,
				`${method.toUpperCase()} ${path} 缺少 description`,
			).toBeTypeOf("string");
			expect(operation.description?.trim().length).toBeGreaterThan(0);
		}
	});

	it("只保留 health 系统探针，并为所有分组提供说明", () => {
		const document = SwaggerModule.createDocument(app, createSwaggerConfig());
		const paths = Object.keys(document.paths);

		expect(paths.some((path) => path.endsWith("/health"))).toBe(true);
		expect(paths.some((path) => path.endsWith("/hello"))).toBe(false);
		expect(document.tags).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "System",
					description: expect.any(String),
				}),
				expect.objectContaining({
					name: "Auth",
					description: expect.any(String),
				}),
				expect.objectContaining({
					name: "Rate",
					description: expect.any(String),
				}),
			]),
		);
	});

	it("账户分配明细的 OpenAPI 契约要求传入币种路径参数", () => {
		const document = SwaggerModule.createDocument(app, createSwaggerConfig());
		const operation = document.paths["/api/accounts/{currencyCode}/allocations"]?.get;

		expect(operation?.parameters).toEqual([
			expect.objectContaining({
				name: "currencyCode",
				in: "path",
				required: true,
				schema: expect.objectContaining({ type: "string" }),
			}),
		]);
	});
});
