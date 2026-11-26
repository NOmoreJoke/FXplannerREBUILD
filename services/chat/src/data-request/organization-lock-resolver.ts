import { Inject, Injectable } from "@nestjs/common";
import type {
	CombinedLockResolution,
	OrganizationLockResolver,
} from "../authorization/guards/organization-lock.guard";
import { DataRequestService } from "./data-request.service";

/**
 * 组织锁解析器实现（技术方案 §9.3；Goal #3B W27）。
 *
 * 职责边界：授权层（authorization/）只声明守卫与契约，**禁止引入业务记账模块**
 * （AGENTS.md + eslint 架构红线）；「读时惰性推进 + 锁判定」的真实实现留在
 * data-request/（DataRequestService），经全局模块导出后由守卫注入——
 * 与 AuditModule（@Global）供 PermissionGuard 注入 AuditService 的先例同构。
 *
 * 一次解析覆盖两把锁（个人账号注销 + 当前组织数据锁），底层只发 **1 条**
 * `data_requests` 合并查询（技术方案 §9.3「至多 1 条」）。
 *
 * 注入令牌：ORGANIZATION_LOCK_RESOLVER（由 DataRequestModule 以 useExisting 提供）。
 */
@Injectable()
export class DataRequestOrganizationLockResolver implements OrganizationLockResolver {
	constructor(
		@Inject(DataRequestService)
		private readonly dataRequestService: DataRequestService,
	) {}

	async resolve(
		actor: { userId: string; organizationId: string },
		options: { method: string },
	): Promise<CombinedLockResolution> {
		const result = await this.dataRequestService.advanceAndResolveCombinedLock(
			actor,
			options,
		);
		return {
			userDeleted: result.userDeleted,
			personalLock: result.personalLock,
			organizationDeleted: result.organizationDeleted,
			organizationLock: result.organizationLock,
			lockSubject: result.personalLock
				? result.personalLockSubject
				: result.organizationLockSubject,
			organizationLockSummary: result.organizationLockSummary,
		};
	}
}
