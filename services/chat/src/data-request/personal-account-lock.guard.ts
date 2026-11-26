import {
	type CanActivate,
	type ExecutionContext,
	Inject,
	Injectable,
	Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { RequestAuthService } from "../auth/request-auth.service";
import { OrganizationLockGuard } from "../authorization/guards/organization-lock.guard";
import { SKIP_PERSONAL_ACCOUNT_LOCK_KEY } from "../authorization/guards/data-lock.decorators";
import { DataRequestLockedException } from "./dto/data-request.dto";
import { DataRequestService } from "./data-request.service";

/**
 * 个人账号锁全局守卫（技术方案 §9.1–§9.3；Goal #3B W27）。
 *
 * 职责（按序）：
 * 1. 通过 RequestAuthService 复用同请求内的身份解析结果（单次验签 + 单次 users
 *    查询，与 JwtAuthGuard 共享）；无 / 无效 / 已删除用户的 token 直接放行，
 *    401 交由 JwtAuthGuard 统一处理（本守卫零查 data_requests）；
 * 2. **路由已挂 OrganizationLockGuard 时直接放行**（合并查询）：组织上下文端点由
 *    OrganizationLockGuard 用**同一条合并查询**判定两把锁（个人注销 + 组织锁），
 *    此处再查一次就会回到「个人锁 1 条 + 组织锁 1 条」的固定 2 条，违背
 *    技术方案 §9.3「至多 1 条 data_requests 查询」；
 * 3. 其余端点：执行**至多 1 次** `data_requests` SELECT（scope = PERSONAL、
 *    type = DELETION、status ∈ ACTIVE_STATUSES）合并完成「读时惰性推进」与
 *    「锁判定」：
 *    a. 到期 PERSONAL DELETION 在事务内执行清理；若物理删除了 User，立即调用
 *       `invalidateRequestUser(request)`，让同次请求后续的 JwtAuthGuard 返回 401
 *       （零查 data_requests、防伪过关）；
 *    b. 非白名单端点：本人注销进行中 → 403 ACCOUNT_PENDING_DELETION；
 * 4. **绝不锁同组织的其他成员**：本守卫只看「本人名下」的个人域请求，
 *    不查询、不拦截任何 scope = ORGANIZATION 的请求（组织锁由
 *    OrganizationLockGuard 按当前组织上下文独立判定）。
 *
 * Fail-closed 纪律：非白名单端点遇库查询异常必须抛 500（不得因查不到锁状态
 * 而放行注销中的账号）；白名单端点仅 log warn 并放行查看 / 撤回 / 下载。
 */
@Injectable()
export class PersonalAccountLockGuard implements CanActivate {
	private readonly logger = new Logger(PersonalAccountLockGuard.name);

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

		// 路由已挂 OrganizationLockGuard → 合并查询交由它执行（保持「至多 1 条」不变量）
		if (this.hasOrganizationLockGuard(context)) {
			return true;
		}

		const skipLock = Boolean(
			this.reflector.getAllAndOverride<boolean>(
				SKIP_PERSONAL_ACCOUNT_LOCK_KEY,
				[context.getHandler(), context.getClass()],
			),
		);

		let result: Awaited<
			ReturnType<DataRequestService["advanceAndResolvePersonalLock"]>
		>;
		try {
			result = await this.dataRequestService.advanceAndResolvePersonalLock(
				auth.user.id,
				{ skipLock, method: request.method },
			);
		} catch (error) {
			// 非白名单受保护端点必须 fail-closed：避免锁状态库查询异常时绕过注销锁定
			if (!skipLock) {
				throw error;
			}
			this.logger.warn(
				`[data-request] 个人锁白名单端点读时推进失败（不阻塞进度/撤回，下次到访重试）: userId=${auth.user.id}, error=${error instanceof Error ? error.message : String(error)}`,
			);
			return true;
		}

		if (result.userDeleted) {
			// 到期注销已物理删除 User：让同次请求的 JwtAuthGuard 立即返回 401
			this.requestAuth.invalidateRequestUser(request);
			return true;
		}
		if (result.lock) {
			throw new DataRequestLockedException(result.lock);
		}
		return true;
	}

	/**
	 * 路由是否挂了 OrganizationLockGuard（NestJS 守卫元数据 `__guards__`）：
	 * 兼容**类引用**与**实例**两种写法（@UseGuards 传类或传实例均可）。
	 */
	private hasOrganizationLockGuard(context: ExecutionContext): boolean {
		const guards = this.reflector.getAllAndMerge<unknown[]>("__guards__", [
			context.getHandler(),
			context.getClass(),
		]);
		return (guards ?? []).some((candidate) => {
			if (candidate === OrganizationLockGuard) return true;
			if (typeof candidate === "function") return false;
			return (
				(candidate as { constructor?: unknown } | null)?.constructor ===
				OrganizationLockGuard
			);
		});
	}
}
