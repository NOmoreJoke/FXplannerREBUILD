import {
	type CanActivate,
	type ExecutionContext,
	Inject,
	Injectable,
} from "@nestjs/common";
import { RequestAuthService } from "../../auth/request-auth.service";
import { PrismaService } from "../../prisma/prisma.service";
import type { OrganizationRole } from "../authorization.types";
import {
	OrganizationNotFoundException,
	OrganizationRequiredException,
} from "../authorization.errors";
import type { RequestWithActor } from "./organization-context.guard";

/** cuid 校验（Prisma cuid()：c 开头 25 位小写字母数字） */
const CUID_PATTERN = /^c[a-z0-9]{24}$/;

/**
 * 业务端点组织作用域守卫（GOAL-3A W18 兼容窗口；技术方案 §7.3 迁移期规则）。
 *
 * 与 OrganizationContextGuard（严格版，组织管理端点用）的差异仅在缺头时：
 * - 有头：行为一致（cuid 校验 400 / 实时 ACTIVE Membership 404 不泄露存在性）；
 * - 无头：**兼容窗口回落**——用户恰好只有 1 个 ACTIVE 组织时映射到该组织；
 *   0 个或 ≥2 个组织仍严格 400 ORGANIZATION_REQUIRED（禁猜测默认组织，
 *   技术方案 §7.3「用户已有多个组织后禁止映射」）。
 *
 * W22（Goal #3B 切写 + 前端全量带头）后本守卫收敛为严格语义或直接替换为
 * OrganizationContextGuard；业务 GET 以本守卫解析 request.actor。
 */
@Injectable()
export class BusinessOrgScopeGuard implements CanActivate {
	constructor(
		@Inject(RequestAuthService)
		private readonly requestAuth: RequestAuthService,
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<RequestWithActor>();

		const auth = await this.requestAuth.resolveBearerUser(request);
		if (auth.status !== "authenticated") {
			return true; // 交由守卫链中的 JwtAuthGuard 统一 401
		}

		const header = request.headers["x-organization-id"];
		// 数组头严格拒绝（对齐 OrganizationContextGuard 口径，对抗审 R1 [Nit]）
		if (Array.isArray(header)) {
			throw new OrganizationRequiredException();
		}

		let organizationId: string;
		if (typeof header === "string" && CUID_PATTERN.test(header.trim())) {
			organizationId = header.trim();
		} else if (typeof header === "undefined") {
			// 兼容窗口：无头时回落到唯一 ACTIVE 组织
			const memberships = await this.prisma.membership.findMany({
				where: { userId: auth.user.id, status: "ACTIVE" },
				select: { organizationId: true },
			});
			if (memberships.length !== 1 || !memberships[0]) {
				throw new OrganizationRequiredException(
					"缺少组织上下文（X-Organization-Id），且无法唯一确定默认组织",
				);
			}
			organizationId = memberships[0].organizationId;
		} else {
			throw new OrganizationRequiredException();
		}

		const membership = await this.prisma.membership.findUnique({
			where: {
				organizationId_userId: { organizationId, userId: auth.user.id },
			},
			select: { id: true, role: true, status: true },
		});
		if (!membership || membership.status !== "ACTIVE") {
			throw new OrganizationNotFoundException();
		}

		request.actor = {
			userId: auth.user.id,
			organizationId,
			membershipId: membership.id,
			role: membership.role as OrganizationRole,
			authMethod: "USER",
		};
		return true;
	}
}
