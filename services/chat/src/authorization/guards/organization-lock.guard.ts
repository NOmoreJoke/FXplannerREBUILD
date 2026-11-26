import {
	type CanActivate,
	type ExecutionContext,
	Inject,
	Injectable,
	Logger,
	UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RequestAuthService } from "../../auth/request-auth.service";
import {
	AccountPendingDeletionException,
	OrganizationDataLockedException,
	OrganizationNotFoundException,
} from "../authorization.errors";
import type { RequestWithActor } from "./organization-context.guard";
import {
	SKIP_ORGANIZATION_LOCK_KEY,
	SKIP_PERSONAL_ACCOUNT_LOCK_KEY,
} from "./data-lock.decorators";

/**
 * 个人账号锁判定结果（null = 放行）。
 *
 * 命名纪律（评审 N-6）：契约层用 `*ErrorCode` 后缀，与规则层
 * data-request-rules.ts 的 `PersonalLockResolution` / `OrganizationLockResolution`
 * 彻底区隔——两层不出现同名类型，避免跨模块 import 时的歧义。
 */
export type PersonalLockErrorCode = null | "ACCOUNT_PENDING_DELETION";

/** 组织数据锁判定结果（null = 放行） */
export type OrganizationLockErrorCode = null | "ORGANIZATION_DATA_LOCKED";

/** 组织锁摘要（供 OrganizationService.getCurrent 复用，消除第 3 次查库） */
export interface OrganizationLockSummary {
	active: boolean;
	type: string | null;
}

/**
 * 双锁解析器契约（横切依赖注入点）。
 *
 * 纪律：授权层只声明契约与守卫，**不引入业务记账模块**（AGENTS.md +
 * eslint 架构红线：authorization 禁止引入 data-request 等业务模块）。锁的
 * 「读时惰性推进 + 锁判定」实现位于 `data-request/`
 * （DataRequestOrganizationLockResolver），经全局模块导出后在此注入——
 * 与 AuditModule（@Global）供 PermissionGuard 注入 AuditService 的先例同构。
 *
 * 一次解析覆盖**两把锁**（技术方案 §9.3「至多 1 条 data_requests 查询」）：
 * 个人域注销 + 当前组织清空 / 删除由同一条合并查询取出。
 */
export interface OrganizationLockResolver {
	resolve(
		actor: { userId: string; organizationId: string },
		options: { method: string },
	): Promise<CombinedLockResolution>;
}

/**
 * 双锁解析结果（**合并查询**一次得出两把锁的判定）。
 *
 * 命名纪律（评审 N-6）：本类型名为 `CombinedLockResolution`，与规则层
 * data-request-rules.ts 的 `OrganizationLockResolution`（仅组织域锁判定结果）
 * 彻底区隔——两层不出现同名类型，避免跨模块 import 时的歧义。
 */
export interface CombinedLockResolution {
	/** 到期个人注销已物理删除 User（守卫据此让同次请求 401） */
	userDeleted: boolean;
	/** 个人账号锁判定结果 */
	personalLock: PersonalLockErrorCode;
	/** 到期组织删除已删掉组织（守卫据此 404，不得残留虚幻权限） */
	organizationDeleted: boolean;
	/** 组织数据锁判定结果 */
	organizationLock: OrganizationLockErrorCode;
	/** 触发锁的请求（供守卫给出准确文案） */
	lockSubject: { scope: string; type: string } | null;
	/** 组织锁摘要（挂到 request，供当前组织视图复用） */
	organizationLockSummary: OrganizationLockSummary;
}

/** 双锁解析器注入令牌 */
export const ORGANIZATION_LOCK_RESOLVER = "ORGANIZATION_LOCK_RESOLVER";

/**
 * 带组织锁摘要的请求（OrganizationLockGuard 挂载，OrganizationService 消费）
 */
export interface RequestWithOrganizationLock extends RequestWithActor {
	organizationLock?: OrganizationLockSummary;
}

/**
 * 组织数据锁守卫（技术方案 §9.1–§9.3；Goal #3B W27）。
 *
 * 一把守卫同时负责两把锁，**每个请求至多 1 条 `data_requests` SELECT**：
 * - 组织上下文端点：本守卫执行 1 条**合并查询**（个人域注销 + 当前组织清空/删除），
 *   一次查询同时得出「读时惰性推进」候选与「锁判定」结果；
 * - 未挂本守卫的端点：由 PersonalAccountLockGuard 执行其个人域单查
 *   （`data-request/personal-account-lock.guard.ts` 读取路由 `__guards__` 元数据后跳过）。
 *
 * 挂载顺序铁律：**在 OrganizationContextGuard / BusinessOrgScopeGuard 之后、
 * PermissionGuard 之前**（先解析 actor.organizationId，再检锁，再检权限）。
 * 严禁放错位置——放前则 actor 尚未解析（无 actor 绕过），放后则权限拒绝会先于
 * 锁判定返回 403，用户看不到组织正在清空 / 删除的真实原因。
 *
 * 判定顺序（个人优先，绝不跨域误判）：
 * 1. 到期个人注销物理删除了 User → `invalidateRequestUser` + **直接 401**
 *    （JwtAuthGuard 已在此前通过，必须由本守卫兜底 401）；
 * 2. 个人注销锁定激活且未标 `@SkipPersonalAccountLock()` → 403
 *    `ACCOUNT_PENDING_DELETION`（只锁本人，绝不锁同组织他人）；
 * 3. 到期组织删除已删掉组织 → 404（不得残留虚幻权限）；
 * 4. 组织锁激活且未标 `@SkipOrganizationLock()` → 403 `ORGANIZATION_DATA_LOCKED`
 *    （CLEAR PENDING 仅拦非 GET；CLEAR PROCESSING/FAILED 与 DELETION 活跃全拦）。
 *
 * Fail-closed：库查询异常且（个人锁未跳过 **或** 组织锁未跳过）→ 抛 500
 * （不得因查不到锁状态而放行注销中的账号或被锁组织的写操作）。
 */
@Injectable()
export class OrganizationLockGuard implements CanActivate {
	private readonly logger = new Logger(OrganizationLockGuard.name);

	constructor(
		// 显式 @Inject：bun 转译不支持 emitDecoratorMetadata（先例 authorization 守卫）
		@Inject(Reflector) private readonly reflector: Reflector,
		@Inject(ORGANIZATION_LOCK_RESOLVER)
		private readonly resolver: OrganizationLockResolver,
		@Inject(RequestAuthService)
		private readonly requestAuth: RequestAuthService,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<RequestWithOrganizationLock>();
		const actor = request.actor;
		if (!actor) {
			// 装配错误兜底（fail-closed）：组织上下文未解析时绝不放行
			throw new UnauthorizedException();
		}

		const skipPersonalLock = Boolean(
			this.reflector.getAllAndOverride<boolean>(
				SKIP_PERSONAL_ACCOUNT_LOCK_KEY,
				[context.getHandler(), context.getClass()],
			),
		);
		const skipOrganizationLock = Boolean(
			this.reflector.getAllAndOverride<boolean>(
				SKIP_ORGANIZATION_LOCK_KEY,
				[context.getHandler(), context.getClass()],
			),
		);

		let result: CombinedLockResolution;
		try {
			result = await this.resolver.resolve(
				{ userId: actor.userId, organizationId: actor.organizationId },
				{ method: request.method },
			);
		} catch (error) {
			// fail-closed：任一把锁未被跳过时，查不到锁状态必须拒绝（抛 500）
			if (!skipPersonalLock || !skipOrganizationLock) {
				throw error;
			}
			this.logger.warn(
				`[data-request] 双锁白名单端点读时推进失败（不阻塞进度/撤回，下次到访重试）: userId=${actor.userId}, organizationId=${actor.organizationId}, error=${error instanceof Error ? error.message : String(error)}`,
			);
			return true;
		}

		if (result.userDeleted) {
			// 到期个人注销已物理删除 User：让同次请求立即 401
			this.requestAuth.invalidateRequestUser(request);
			throw new UnauthorizedException("Token 无效或已过期");
		}
		if (result.personalLock && !skipPersonalLock) {
			throw new AccountPendingDeletionException();
		}
		if (result.organizationDeleted) {
			// 到期组织删除已执行：组织已不存在，不得残留虚幻权限
			throw new OrganizationNotFoundException();
		}
		if (result.organizationLock && !skipOrganizationLock) {
			throw new OrganizationDataLockedException(result.lockSubject);
		}
		// 组织锁摘要挂到 request：当前组织视图据此复用，消除第 3 次 data_requests 查询
		request.organizationLock = result.organizationLockSummary;
		return true;
	}
}
