import {
	type CanActivate,
	type ExecutionContext,
	Inject,
	Injectable,
	UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { RequestAuthService } from "../../auth/request-auth.service";
import { PrismaService } from "../../prisma/prisma.service";
import { isOrganizationRole } from "../authorization.types";
import type { ActorContext } from "../authorization.types";
import {
	OrganizationNotFoundException,
	OrganizationRequiredException,
	PermissionDeniedException,
} from "../authorization.errors";

/** 组织上下文请求扩展（request.actor 由本守卫挂载） */
export interface RequestWithActor extends Request {
	actor?: ActorContext;
}

/** cuid 校验（Prisma cuid()：c 开头 25 位小写字母数字） */
const CUID_PATTERN = /^c[a-z0-9]{24}$/;

/**
 * 组织上下文守卫（技术方案 §4.3；AUTH-02 降权秒级生效；Goal #3A W17）。
 *
 * 职责（按序）：
 * 1. 经 RequestAuthService 复用 W9 请求级身份（同请求与 JwtAuthGuard 共享
 *    验签与 users 查询结果，不重复验签）；
 * 2. 读取 x-organization-id：缺失 / 非字符串（数组头）/ 格式非法 →
 *    400 ORGANIZATION_REQUIRED（W30 MIG-D 起**不再**猜测「唯一默认组织」，
 *    业务端点一律要求显式组织头）；
 * 3. 实时查询 Membership（organizationId+userId 复合唯一）：不存在或
 *    status !== ACTIVE → 统一 404 ORGANIZATION_NOT_FOUND（不泄露存在性，
 *    禁止 403）；角色/禁用变更即时生效（每请求实时查，无角色缓存）；
 * 4. 构造 request.actor: ActorContext。
 *
 * 挂载顺序：@UseGuards(JwtAuthGuard, OrganizationContextGuard, PermissionGuard)。
 */
@Injectable()
export class OrganizationContextGuard implements CanActivate {
	constructor(
		// 显式 @Inject：bun 转译不支持 emitDecoratorMetadata（先例 data-request-lock.guard）
		@Inject(RequestAuthService)
		private readonly requestAuth: RequestAuthService,
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<RequestWithActor>();

		const auth = await this.requestAuth.resolveBearerUser(request);
		if (auth.status !== "authenticated") {
			// 正常链路 JwtAuthGuard 先行；此处为装配错误时的 fail-closed 兜底（评审 N-04）
			throw new UnauthorizedException();
		}

		const header = request.headers["x-organization-id"];
		// 数组头严格拒绝（对抗审 R1 [Nit]：对齐文档口径，不静默取首元素）
		if (Array.isArray(header)) {
			throw new OrganizationRequiredException();
		}
		if (typeof header !== "string" || !CUID_PATTERN.test(header.trim())) {
			throw new OrganizationRequiredException();
		}
		const organizationId = header.trim();

		const membership = await this.prisma.membership.findUnique({
			where: {
				organizationId_userId: { organizationId, userId: auth.user.id },
			},
			select: { id: true, role: true, status: true },
		});
		if (!membership || membership.status !== "ACTIVE") {
			throw new OrganizationNotFoundException();
		}
		// 角色合法性 fail-closed（评审 I-13：role 为非约束 TEXT，禁止断言放行未知值）
		if (!isOrganizationRole(membership.role)) {
			throw new PermissionDeniedException("成员角色无效，拒绝访问");
		}

		request.actor = {
			userId: auth.user.id,
			organizationId,
			membershipId: membership.id,
			role: membership.role,
			authMethod: "USER",
		};
		return true;
	}
}
