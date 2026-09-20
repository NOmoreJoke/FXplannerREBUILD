import {
	type CanActivate,
	type ExecutionContext,
	Inject,
	Injectable,
	Logger,
	SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { env } from "../config/env";
import {
	ACTIVE_STATUSES,
	resolveLock,
	type DataRequestStatus,
	type DataRequestType,
} from "./data-request-rules";
import { DataRequestLockedException } from "./dto/data-request.dto";
import { DataRequestService } from "./data-request.service";

/** 白名单装饰器：标注的 controller/handler 跳过锁判定（方案 §3.3） */
export const SKIP_DATA_REQUEST_LOCK_KEY = "skipDataRequestLock";
export const SkipDataRequestLock = () =>
	SetMetadata(SKIP_DATA_REQUEST_LOCK_KEY, true);

/** 进行中的 CLEAR/DELETION 请求（锁判定的数据来源） */
export interface DataRequestLockInfo {
	type: DataRequestType;
	status: DataRequestStatus;
}

function extractBearerToken(request: Request): string | null {
	const header = request.headers.authorization;
	if (!header || !header.startsWith("Bearer ")) return null;
	const token = header.slice("Bearer ".length).trim();
	return token || null;
}

/**
 * 数据请求锁全局守卫（account-data 技术方案 §3.3）。
 *
 * 职责（按序）：
 * 1. 白名单（@SkipDataRequestLock）直接放行；
 * 2. 无/无效 Bearer token 放行（401 由 JwtAuthGuard 负责，公开端点不受影响）；
 * 3. 读时惰性推进：本人到期的 CLEAR/DELETION 请求先在事务内推进（PENDING/FAILED
 *    → 清理 → COMPLETED），失败仅告警不阻塞请求（下次到访重试）；
 * 4. 锁判定：DELETION 三态全锁；CLEAR PROCESSING/FAILED 全锁；CLEAR PENDING 仅锁非 GET。
 *
 * 注册：AppModule 以 APP_GUARD 挂载（先于控制器守卫执行，此处自行验签 JWT——
 * 方案原设想挂在 jwt.strategy，因全局守卫先于 passport 流程执行，调整为守卫自查）。
 */
@Injectable()
export class DataRequestLockGuard implements CanActivate {
	private readonly logger = new Logger(DataRequestLockGuard.name);

	constructor(
		// 显式 @Inject：bun 转译不支持 emitDecoratorMetadata，裸类型参数元数据缺失会导致
		// export-openapi（bun 运行）下依赖解析失败（vitest/node 下无此问题）
		@Inject(Reflector) private readonly reflector: Reflector,
		@Inject(JwtService) private readonly jwtService: JwtService,
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(DataRequestService)
		private readonly dataRequestService: DataRequestService,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const http = context.switchToHttp();
		const request = http.getRequest<Request>();

		const token = extractBearerToken(request);
		if (!token) return true;
		let userId: string;
		try {
			const payload = this.jwtService.verify(token, {
				secret: env.JWT_SECRET,
			}) as { userId?: unknown };
			if (typeof payload?.userId !== "string" || !payload.userId) return true;
			userId = payload.userId;
		} catch {
			return true; // token 无效/过期：交给 JwtAuthGuard 统一 401
		}

		// 读时惰性推进（到期 CLEAR/DELETION 先清理再放行；失败仅告警，下次到访重试）。
		// 白名单端点（进度页/下载）也必须执行推进：那是注销/清空用户唯一可达的入口，
		// 否则「到期后的下一次访问」永远不会触发清理。
		try {
			await this.dataRequestService.advanceDueRequests(userId);
		} catch (error) {
			this.logger.warn(
				`[data-request] 读时推进失败（不阻塞请求，下次到访重试）: userId=${userId}, error=${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// 白名单只跳过锁判定（推进已完成）
		const skip = this.reflector.getAllAndOverride<boolean>(
			SKIP_DATA_REQUEST_LOCK_KEY,
			[context.getHandler(), context.getClass()],
		);
		if (skip) return true;

		const active = (await this.prisma.dataRequest.findFirst({
			where: {
				userId,
				type: { in: ["CLEAR", "DELETION"] },
				status: { in: ACTIVE_STATUSES as string[] },
			},
			orderBy: { requestedAt: "desc" },
			select: { type: true, status: true },
		})) as DataRequestLockInfo | null;

		const resolution = resolveLock(active, request.method);
		if (resolution) {
			throw new DataRequestLockedException(resolution);
		}

		return true;
	}
}
