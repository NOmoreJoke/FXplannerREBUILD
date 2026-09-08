import { UnauthorizedException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	process.env.NODE_ENV = "test";
	process.env.API_PORT ??= "4001";
	process.env.CORS_ORIGIN ??= "http://localhost:3000";
	process.env.DATABASE_URL ??=
		"postgresql://postgres:postgres@localhost:5432/fxplanner_new";
	process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-32-characters";
});

import type { PrismaService } from "../../prisma/prisma.service";
import { JwtStrategy } from "./jwt.strategy";

describe("JwtStrategy", () => {
	let strategy: JwtStrategy;
	let prisma: { user: { findUnique: ReturnType<typeof vi.fn> } };

	beforeEach(() => {
		prisma = { user: { findUnique: vi.fn() } };
		strategy = new JwtStrategy(prisma as unknown as PrismaService);
	});

	it("根据 payload 的 userId 返回公开用户字段", async () => {
		const user = {
			id: "user-1",
			email: "user@example.com",
			name: "测试用户",
			avatar: null,
			createdAt: new Date("2026-08-03T00:00:00.000Z"),
		};
		prisma.user.findUnique.mockResolvedValue(user);

		const validated = await strategy.validate({
			userId: user.id,
			email: user.email,
		});

		expect(validated).toEqual(user);
		expect(validated).not.toHaveProperty("passwordHash");
		expect(prisma.user.findUnique).toHaveBeenCalledWith({
			where: { id: user.id },
			select: {
				id: true,
				email: true,
				name: true,
				avatar: true,
				createdAt: true,
			},
		});
	});

	it("Token 对应用户不存在时拒绝请求", async () => {
		prisma.user.findUnique.mockResolvedValue(null);

		await expect(
			strategy.validate({ userId: "missing", email: "missing@example.com" }),
		).rejects.toBeInstanceOf(UnauthorizedException);
	});
});
