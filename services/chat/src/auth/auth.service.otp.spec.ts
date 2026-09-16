import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "./auth.service";

const otpUser = {
	id: "otp-user-1",
	email: null,
	passwordHash: null,
	name: null,
	avatar: null,
	createdAt: new Date("2026-08-03T00:00:00.000Z"),
	updatedAt: new Date("2026-08-03T00:00:00.000Z"),
};

const passwordUser = {
	id: "password-user-1",
	email: "bound@example.com",
	passwordHash: "hashed-password",
	name: null,
	avatar: null,
	createdAt: new Date("2026-08-01T00:00:00.000Z"),
	updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

function createPrismaMock() {
	const otpIdentity = {
		findUnique: vi.fn(),
		create: vi.fn(),
	};
	const user = {
		findUnique: vi.fn(),
		create: vi.fn(),
	};
	const prisma = {
		otpIdentity,
		user,
		$transaction: vi.fn(async (callback: (tx: typeof prisma) => unknown) =>
			callback(prisma),
		),
	};
	return prisma;
}

describe("AuthService OTP account", () => {
	let prisma: ReturnType<typeof createPrismaMock>;
	let jwtService: { sign: ReturnType<typeof vi.fn> };
	let service: AuthService;

	beforeEach(() => {
		prisma = createPrismaMock();
		jwtService = { sign: vi.fn().mockReturnValue("otp-access-token") };
		service = new AuthService(
			prisma as unknown as PrismaService,
			jwtService as never,
		);
	});

	it("email 渠道命中同邮箱密码账号时，绑定该账号登录且不创建新 User", async () => {
		prisma.otpIdentity.findUnique.mockResolvedValue(null);
		prisma.user.findUnique.mockResolvedValue(passwordUser);
		prisma.otpIdentity.create.mockResolvedValue({
			id: "identity-1",
			userId: passwordUser.id,
		});

		const result = await service.loginWithOtp({
			channel: "email",
			target: "bound@example.com",
		});

		expect(prisma.user.findUnique).toHaveBeenCalledWith({
			where: { email: "bound@example.com" },
		});
		expect(prisma.user.create).not.toHaveBeenCalled();
		expect(prisma.otpIdentity.create).toHaveBeenCalledWith({
			data: {
				userId: passwordUser.id,
				channel: "email",
				target: "bound@example.com",
			},
		});
		expect(result).toMatchObject({
			accessToken: "otp-access-token",
			identity: { channel: "email", target: "bound@example.com" },
			user: { id: passwordUser.id, email: "bound@example.com" },
		});
		expect(result.user).not.toHaveProperty("passwordHash");
	});

	it("phone 渠道不匹配密码账号（无手机号列），仍创建独立 OTP 账号", async () => {
		prisma.otpIdentity.findUnique.mockResolvedValue(null);
		prisma.user.create.mockResolvedValue(otpUser);
		prisma.otpIdentity.create.mockResolvedValue({
			id: "identity-1",
			userId: otpUser.id,
		});

		const result = await service.loginWithOtp({
			channel: "phone",
			target: "+8613800138000",
		});

		expect(prisma.user.findUnique).not.toHaveBeenCalled();
		expect(prisma.user.create).toHaveBeenCalledWith({ data: {} });
		expect(result.user.id).toBe(otpUser.id);
		expect(result.user.email).toBeNull();
	});

	it("首次 OTP 验证创建没有邮箱和密码的独立账号", async () => {
		prisma.otpIdentity.findUnique.mockResolvedValue(null);
		prisma.user.findUnique.mockResolvedValue(null);
		prisma.user.create.mockResolvedValue(otpUser);
		prisma.otpIdentity.create.mockResolvedValue({
			id: "identity-1",
			userId: otpUser.id,
		});

		const result = await service.loginWithOtp({
			channel: "email",
			target: "otp@example.com",
		});

		expect(prisma.user.create).toHaveBeenCalledWith({ data: {} });
		expect(prisma.otpIdentity.create).toHaveBeenCalledWith({
			data: {
				userId: otpUser.id,
				channel: "email",
				target: "otp@example.com",
			},
		});
		expect(result).toMatchObject({
			accessToken: "otp-access-token",
			identity: { channel: "email", target: "otp@example.com" },
			user: { id: otpUser.id, email: null },
		});
		expect(result.user).not.toHaveProperty("passwordHash");
	});

	it("同一 OTP identity 只复用 OTP 账号，不查询或合并密码账号", async () => {
		prisma.otpIdentity.findUnique.mockResolvedValue({
			id: "identity-1",
			user: otpUser,
		});

		const result = await service.loginWithOtp({
			channel: "email",
			target: "otp@example.com",
		});

		expect(prisma.otpIdentity.findUnique).toHaveBeenCalledWith({
			where: {
				channel_target: {
					channel: "email",
					target: "otp@example.com",
				},
			},
			include: { user: true },
		});
		expect(prisma.user.findUnique).not.toHaveBeenCalled();
		expect(prisma.user.create).not.toHaveBeenCalled();
		expect(prisma.otpIdentity.create).not.toHaveBeenCalled();
		expect(result.user.id).toBe(otpUser.id);
	});
});
