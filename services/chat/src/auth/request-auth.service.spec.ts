import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { RequestAuthService } from "./request-auth.service";

const mkReq = (authorization?: string): Request =>
	({
		headers: authorization === undefined ? {} : { authorization },
	}) as unknown as Request;

describe("RequestAuthService", () => {
	let jwtService: { verify: ReturnType<typeof vi.fn> };
	let prisma: { user: { findUnique: ReturnType<typeof vi.fn> } };
	let service: RequestAuthService;

	const sampleUser = {
		id: "user-1",
		email: "u@example.com",
		name: "User",
		avatar: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};

	beforeEach(() => {
		jwtService = { verify: vi.fn() };
		prisma = { user: { findUnique: vi.fn() } };
		service = new RequestAuthService(
			jwtService as never,
			prisma as unknown as PrismaService,
		);
	});

	it("无 Authorization header 返回 missing，零验签零查库", async () => {
		const res = await service.resolveBearerUser(mkReq());
		expect(res).toEqual({ status: "missing" });
		expect(jwtService.verify).not.toHaveBeenCalled();
		expect(prisma.user.findUnique).not.toHaveBeenCalled();
	});

	it("同一 Request 多次解析仅验签 1 次、查 user 1 次，并注入 request.user", async () => {
		jwtService.verify.mockReturnValue({
			userId: "user-1",
			email: "u@example.com",
		});
		prisma.user.findUnique.mockResolvedValue(sampleUser);
		const req = mkReq("Bearer valid.jwt.token");

		const [first, second] = await Promise.all([
			service.resolveBearerUser(req),
			service.resolveBearerUser(req),
		]);
		const third = await service.resolveBearerUser(req);

		expect(first).toEqual({ status: "authenticated", user: sampleUser });
		expect(second).toBe(first);
		expect(third).toBe(first);
		expect((req as unknown as { user?: unknown }).user).toEqual(sampleUser);
		expect(jwtService.verify).toHaveBeenCalledTimes(1);
		expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
		expect(prisma.user.findUnique).toHaveBeenCalledWith({
			where: { id: "user-1" },
			select: {
				id: true,
				email: true,
				name: true,
				avatar: true,
				createdAt: true,
			},
		});
	});

	it("不同 Request 实例互相隔离", async () => {
		jwtService.verify.mockReturnValue({ userId: "user-1" });
		prisma.user.findUnique.mockResolvedValue(sampleUser);

		await service.resolveBearerUser(mkReq("Bearer tok-1"));
		await service.resolveBearerUser(mkReq("Bearer tok-2"));

		expect(jwtService.verify).toHaveBeenCalledTimes(2);
		expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
	});

	it("验签失败 / payload 缺少 userId / email 非字符串均返回 invalid 且不查 user", async () => {
		jwtService.verify.mockImplementationOnce(() => {
			throw new Error("bad token");
		});
		expect(await service.resolveBearerUser(mkReq("Bearer bad"))).toEqual({
			status: "invalid",
		});

		jwtService.verify.mockReturnValueOnce({ userId: "" });
		expect(await service.resolveBearerUser(mkReq("Bearer empty-id"))).toEqual({
			status: "invalid",
		});

		jwtService.verify.mockReturnValueOnce({ userId: "u1", email: 123 });
		expect(await service.resolveBearerUser(mkReq("Bearer bad-email"))).toEqual({
			status: "invalid",
		});

		expect(prisma.user.findUnique).not.toHaveBeenCalled();
	});

	it("数据库无此用户返回 invalid", async () => {
		jwtService.verify.mockReturnValue({ userId: "deleted-user" });
		prisma.user.findUnique.mockResolvedValue(null);

		expect(await service.resolveBearerUser(mkReq("Bearer old-token"))).toEqual({
			status: "invalid",
		});
	});

	it("invalidateRequestUser 立即清除 request.user 并将后续解析置为 invalid", async () => {
		jwtService.verify.mockReturnValue({ userId: "user-1" });
		prisma.user.findUnique.mockResolvedValue(sampleUser);
		const req = mkReq("Bearer valid.token");

		expect((await service.resolveBearerUser(req)).status).toBe("authenticated");
		service.invalidateRequestUser(req);

		expect((req as unknown as { user?: unknown }).user).toBeUndefined();
		expect(await service.resolveBearerUser(req)).toEqual({ status: "invalid" });
		expect(jwtService.verify).toHaveBeenCalledTimes(1);
	});
});
