import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import {
	TEST_ALT_PASSWORD,
	TEST_PASSWORD,
} from "../../test/fixtures/test-credentials";
import { AuthService } from "./auth.service";

const user = {
	id: "user-1",
	email: "user@example.com",
	passwordHash: "",
	name: "测试用户",
	avatar: null,
	createdAt: new Date("2026-08-03T00:00:00.000Z"),
};

describe("AuthService", () => {
	let service: AuthService;
	let prisma: {
		user: {
			findUnique: ReturnType<typeof vi.fn>;
			create: ReturnType<typeof vi.fn>;
		};
		organization: {
			create: ReturnType<typeof vi.fn>;
		};
		$transaction: ReturnType<typeof vi.fn>;
	};
	let jwtService: { sign: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		prisma = {
			user: {
				findUnique: vi.fn(),
				create: vi.fn(),
			},
			organization: {
				create: vi.fn().mockResolvedValue({ id: "org-1" }),
			},
			// W18 注册兜底：user + 默认组织在同一事务创建；单测以「直调回调」透传 mock prisma
			$transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
				run(prisma),
			),
		};
		jwtService = { sign: vi.fn().mockReturnValue("access-token") };
		service = new AuthService(
			prisma as unknown as PrismaService,
			jwtService as never,
		);
	});

	it("注册时哈希密码并且响应不包含 passwordHash", async () => {
		prisma.user.findUnique.mockResolvedValue(null);
		prisma.user.create.mockImplementation(async ({ data }) => ({
			...user,
			email: data.email,
			passwordHash: data.passwordHash,
			name: null,
		}));

		const result = await service.register({
			email: "new@example.com",
			password: TEST_PASSWORD,
		});

		expect(result.accessToken).toBe("access-token");
		expect(result.user).toEqual({
			id: user.id,
			email: "new@example.com",
			name: null,
			avatar: null,
			createdAt: user.createdAt,
		});
		expect(result.user).not.toHaveProperty("passwordHash");
		expect(prisma.user.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				email: "new@example.com",
				passwordHash: expect.any(String),
			}),
		});
		expect(prisma.user.create.mock.calls[0][0].data.passwordHash).not.toBe(
			TEST_PASSWORD,
		);
	});

	it("注册和登录邮箱统一归一化为小写", async () => {
		prisma.user.findUnique.mockResolvedValue(null);
		prisma.user.create.mockResolvedValue(user);

		await service.register({
			email: " USER@Example.COM ",
			password: TEST_PASSWORD,
		});
		expect(prisma.user.findUnique).toHaveBeenCalledWith({
			where: { email: "user@example.com" },
		});
		expect(prisma.user.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ email: "user@example.com" }),
		});

		const passwordHash = await import("bcrypt").then(({ hash }) =>
			hash(TEST_PASSWORD, 10),
		);
		prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash });
		await service.login({
			email: " USER@Example.COM ",
			password: TEST_PASSWORD,
		});
		expect(prisma.user.findUnique).toHaveBeenLastCalledWith({
			where: { email: "user@example.com" },
		});
	});

	it("重复邮箱注册返回 ConflictException", async () => {
		prisma.user.findUnique.mockResolvedValue(user);

		await expect(
			service.register({ email: user.email, password: TEST_PASSWORD }),
		).rejects.toBeInstanceOf(ConflictException);
		expect(prisma.user.create).not.toHaveBeenCalled();
	});

	it("登录成功签发 JWT，错误密码返回 UnauthorizedException", async () => {
		const passwordHash = await import("bcrypt").then(({ hash }) =>
			hash(TEST_PASSWORD, 10),
		);
		prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash });

		const result = await service.login({
			email: user.email,
			password: TEST_PASSWORD,
		});

		expect(result.accessToken).toBe("access-token");
		expect(result.user).not.toHaveProperty("passwordHash");

		await expect(
			service.login({ email: user.email, password: TEST_ALT_PASSWORD }),
		).rejects.toBeInstanceOf(UnauthorizedException);
	});

	it("查询当前用户只选择公开字段", async () => {
		prisma.user.findUnique.mockResolvedValue(user);

		const result = await service.getMe(user.id);

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
		expect(result).toEqual({
			id: user.id,
			email: user.email,
			name: user.name,
			avatar: user.avatar,
			createdAt: user.createdAt,
		});
		expect(result).not.toHaveProperty("passwordHash");
	});
});
