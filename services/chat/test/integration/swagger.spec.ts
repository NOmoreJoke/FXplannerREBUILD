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
		//   GET /api/settings、PATCH /api/settings（用户设置读写）= 31
		expect(operations).toHaveLength(31);
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
});
