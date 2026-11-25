import {
	type CanActivate,
	type ExecutionContext,
	Inject,
	Injectable,
	Logger,
	SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { RequestAuthService } from "../auth/request-auth.service";
import type { DataRequestStatus, DataRequestType } from "./data-request-rules";
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

/**
 * 数据请求锁全局守卫（account-data 技术方案 §3.3 + F1-2 合并优化）。
 *
 * 职责（按序）：
 * 1. 通过 RequestAuthService 解析当前请求身份（同请求内与 JwtAuthGuard 共享结果，
 *    单次验签与 users 查询；无/无效/已删除用户的 token 直接放行，401 交由 JwtAuthGuard 负责）；
 * 2. 通过 DataRequestService.advanceAndResolveLock 单次 SELECT 同时完成：
 *    a. 读时惰性推进（到期 CLEAR/DELETION 在事务内清理）；若 DELETION 物理删除了 User，
 *       立即调用 invalidateRequestUser(req) 确保同次请求的 JwtAuthGuard 统一返回 401；
 *    b. 非 @SkipDataRequestLock() 端点的锁判定（DELETION 全锁；CLEAR PROCESSING/FAILED 全锁；CLEAR PENDING 仅锁非 GET）。
 */
@Injectable()
export class DataRequestLockGuard implements CanActivate {
	private readonly logger = new Logger(DataRequestLockGuard.name);

	constructor(
		// 显式 @Inject：bun 转译不支持 emitDecoratorMetadata，裸类型参数元数据缺失会导致
		// export-openapi（bun 运行）下依赖解析失败（vitest/node 下无此问题）
		@Inject(Reflector) private readonly reflector: Reflector,
		@Inject(RequestAuthService)
		private readonly requestAuth: RequestAuthService,
		@Inject(DataRequestService)
		private readonly dataRequestService: DataRequestService,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const http = context.switchToHttp();
		const request = http.getRequest<Request>();

		const auth = await this.requestAuth.resolveBearerUser(request);
		if (auth.status !== "authenticated") {
			return true; // 无 token / 无效 token / 用户不存在：不查 data_requests，交给 JwtAuthGuard 统一 401
		}

		const skipLock = Boolean(
			this.reflector.getAllAndOverride<boolean>(SKIP_DATA_REQUEST_LOCK_KEY, [
				context.getHandler(),
				context.getClass(),
			]),
		);

		try {
			const result = await this.dataRequestService.advanceAndResolveLock(
				auth.user.id,
				{ skipLock, method: request.method },
			);
			if (result.userDeleted) {
				this.requestAuth.invalidateRequestUser(request);
				return true;
			}
			if (result.lock) {
				throw new DataRequestLockedException(result.lock, result.lockSubject);
			}
		} catch (error) {
			if (error instanceof DataRequestLockedException) {
				throw error;
			}
			// 非白名单受保护端点必须 fail-closed：避免锁状态库查询异常时绕过清理/注销锁定
			if (!skipLock) {
				throw error;
			}
			this.logger.warn(
				`[data-request] 白名单端点读时推进失败（不阻塞进度/撤回，下次到访重试）: userId=${auth.user.id}, error=${error instanceof Error ? error.message : String(error)}`,
			);
		}

		return true;
	}
}
