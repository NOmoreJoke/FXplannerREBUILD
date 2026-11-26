/**
 * 组织范围查询与父子一致断言纯函数（技术方案 §4.4；Goal #3A W16）。
 *
 * 纪律（§4.4.5）：禁止「先按 id 查全表再比对 orgId」的越权读取反模式——
 * 查询条件本身必须携带 organizationId；本模块产出 where 片段与断言函数，
 * 供业务 Service 组装 Prisma 查询（W18 起）。
 *
 * W30（MIG-D/E/F）：兼容窗口（缺 `X-Organization-Id` 时猜唯一默认组织、
 * 读侧回落 `organizationId IS NULL` 存量行）已彻底关闭。组织上下文唯一，
 * 本模块只保留**纯组织作用域**的 where 产出函数与父子一致断言。
 */

import type { ActorContext } from "./authorization.types";

/** 父子组织不一致错误（调用方转译为 404/400，不泄露跨组织结构） */
export class ParentChildOrgMismatchError extends Error {
	constructor(
		readonly parentOrganizationId: string,
		readonly childOrganizationId: string,
	) {
		super("父子记录 organizationId 不一致（禁止跨组织挂载）");
		this.name = "ParentChildOrgMismatchError";
	}
}

/**
 * 业务读作用域：请求者 + 当前组织。
 * 结构上与 ActorContext 兼容——Controller 直接传 actor 即可。
 *
 * W30（MIG-D）：不再携带 `isDefaultOrganization`——兼容回落分支已删除，
 * 组织作用域恒为 `{ organizationId }`。
 */
export interface ReadScope {
	userId: string;
	organizationId: string;
}

/** 组织范围 where 片段：列表/汇总/报告/清理/导出统一以此收口（§4.4.3） */
export function orgWhere(scope: ReadScope | ActorContext): {
	organizationId: string;
} {
	return { organizationId: scope.organizationId };
}

/** 详情/更新/删除的「{ id, organizationId }」条件（§4.4.2：跨组织与不存在统一 404） */
export function ownedRecordWhere(
	id: string,
	scope: ReadScope | ActorContext,
): { id: string; organizationId: string } {
	return { id, organizationId: scope.organizationId };
}

/**
 * 父子 organizationId 一致断言（§5.3.2）：不一致即抛错，调用方必须
 * 在同一事务内先于任何写入调用，禁止静默归组到任一侧。
 */
export function assertParentChildSameOrg(
	parentOrganizationId: string,
	childOrganizationId: string,
): void {
	if (parentOrganizationId !== childOrganizationId) {
		throw new ParentChildOrgMismatchError(
			parentOrganizationId,
			childOrganizationId,
		);
	}
}
