/**
 * 组织范围查询与父子一致断言纯函数（技术方案 §4.4；Goal #3A W16）。
 *
 * 纪律（§4.4.5）：禁止「先按 id 查全表再比对 orgId」的越权读取反模式——
 * 查询条件本身必须携带 organizationId；本模块产出 where 片段与断言函数，
 * 供业务 Service 组装 Prisma 查询（W18 起）。
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

/** 组织范围 where 片段：列表/汇总/报告/清理/导出统一以此收口（§4.4.3） */
export function orgWhere(actor: ActorContext): { organizationId: string } {
	return { organizationId: actor.organizationId };
}

/** 详情/更新/删除的「{ id, organizationId }」条件（§4.4.2：跨组织与不存在统一 404） */
export function ownedRecordWhere(
	id: string,
	actor: ActorContext,
): { id: string; organizationId: string } {
	return { id, organizationId: actor.organizationId };
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

// ─────────────────────────────────────────────────────────────
// W18 兼容窗口读作用域（GOAL-3A W18；技术方案 §7.3 迁移期兼容规则）
// ─────────────────────────────────────────────────────────────

/**
 * 业务读作用域：请求者 + 当前组织 + 是否默认组织。
 * 结构上与 ActorContext 兼容——Controller 直接传 actor 即可。
 */
export interface ReadScope {
	userId: string;
	organizationId: string;
	/** 缺省（undefined）按 false 处理：不带存量回落，fail-closed */
	isDefaultOrganization?: boolean;
}

type CompatBranch =
	| { organizationId: string }
	| { organizationId: null; userId: string };

/**
 * 兼容窗口读 where 片段（W18 专用，W22/Goal #3B 双写切换后移除）：
 * - `organizationId = 当前组织`：MIG-B 已回填行 / 显式组织行（跨用户可见，
 *   同组织成员共享）；
 * - `organizationId IS NULL AND userId = 请求者`：MIG-A 之后、写侧 Actor 化
 *   （Goal #3B）之前经旧写路径产生的过渡期行——逻辑上属请求者的**默认组织**，
 *   仅本人可见，禁止跨用户共享。
 *
 * 评审 I-08：NULL 分支**仅在默认组织上下文**拼接。此前它对任何组织无条件生效，
 *   用户新建组织 B 或受邀加入组织 C 后，其个人未迁移记录会整批渗入 B/C。
 *   `isDefaultOrganization` 由 Guard 按最早的 ACTIVE OWNER 成员关系判定
 *   （default-organization.ts）；缺省一律不带回落。
 */
export function compatReadWhere(scope: ReadScope): { OR: CompatBranch[] } {
	const branches: CompatBranch[] = [{ organizationId: scope.organizationId }];
	if (scope.isDefaultOrganization === true) {
		branches.push({ organizationId: null, userId: scope.userId });
	}
	return { OR: branches };
}

/** SQL（$queryRaw/$executeRaw）用的同口径谓词片段参数（与 compatReadWhere 一致） */
export function compatReadPredicate(scope: ReadScope): {
	organizationId: string;
	userId: string;
	includeLegacy: boolean;
} {
	return {
		organizationId: scope.organizationId,
		userId: scope.userId,
		includeLegacy: scope.isDefaultOrganization === true,
	};
}
