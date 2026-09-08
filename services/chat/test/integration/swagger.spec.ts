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

		// 9 个既有接口 + M0 新增 GET /api/currencies = 10
		expect(operations).toHaveLength(10);
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
