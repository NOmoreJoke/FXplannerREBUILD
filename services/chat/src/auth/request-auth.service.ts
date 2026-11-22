import { Inject, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";

/** 鉴权注入的公开用户视图（与 JwtStrategy.validate 保持同形，绝不含 passwordHash） */
export interface AuthenticatedUser {
	id: string;
	email: string | null;
	name: string | null;
	avatar: string | null;
	createdAt: Date;
}

export type ResolvedRequestAuth =
	| { status: "missing" }
	| { status: "invalid" }
	| { status: "authenticated"; user: AuthenticatedUser };

type RequestWithUser = Request & { user?: AuthenticatedUser };

function extractBearerToken(request: Request): string | null {
	const header = request.headers.authorization;
	if (typeof header !== "string") return null;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	if (!match) return null;
	const token = match[1]?.trim();
	return token || null;
}

/**
 * 请求级认证身份复用服务（F1-2 / DEBT-02）：
 *
 * 将 DataRequestLockGuard 与 JwtAuthGuard 的 Bearer 解析收敛为单次：
 * 同一次 HTTP Request 内共享 JWT 验签与 users 表查询结果，不再双倍验签/重复查库；
 * 若全局锁守卫惰性推进到期注销（DELETION）物理删除了 User，需调用
 * invalidateRequestUser(req) 置无效态，保证下游 JwtAuthGuard 返回 401。
 */
@Injectable()
export class RequestAuthService {
	private readonly cache = new WeakMap<Request, Promise<ResolvedRequestAuth>>();

	constructor(
		@Inject(JwtService) private readonly jwtService: JwtService,
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	resolveBearerUser(request: Request): Promise<ResolvedRequestAuth> {
		const cached = this.cache.get(request);
		if (cached) return cached;

		const promise = this.evaluateRequest(request).catch((error: unknown) => {
			this.cache.delete(request);
			throw error;
		});
		this.cache.set(request, promise);
		return promise;
	}

	/** 到期注销物理删库后立即失效当次请求的认证缓存，确保下游返回 401 */
	invalidateRequestUser(request: Request): void {
		this.cache.set(request, Promise.resolve({ status: "invalid" }));
		delete (request as RequestWithUser).user;
	}

	private async evaluateRequest(request: Request): Promise<ResolvedRequestAuth> {
		const token = extractBearerToken(request);
		if (!token) {
			return { status: "missing" };
		}

		let payload: { userId?: unknown; email?: unknown };
		try {
			payload = this.jwtService.verify(token, {
				secret: env.JWT_SECRET,
			});
		} catch {
			return { status: "invalid" };
		}

		if (
			!payload ||
			typeof payload.userId !== "string" ||
			payload.userId.length === 0
		) {
			return { status: "invalid" };
		}
		if (
			payload.email !== undefined &&
			payload.email !== null &&
			typeof payload.email !== "string"
		) {
			return { status: "invalid" };
		}

		const user = await this.prisma.user.findUnique({
			where: { id: payload.userId },
			select: {
				id: true,
				email: true,
				name: true,
				avatar: true,
				createdAt: true,
			},
		});
		if (!user) {
			return { status: "invalid" };
		}

		(request as RequestWithUser).user = user;
		return { status: "authenticated", user };
	}
}
