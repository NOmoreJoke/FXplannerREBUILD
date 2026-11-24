/**
 * 组织域纯函数规则（技术方案 §4/§6；Goal #3A W17）。
 * W19 将在此追加成员/邀请不变量；本文件保持零 IO。
 */

import {
	isOrganizationRole,
	PERMISSIONS,
	type OrganizationRole,
	type Permission,
} from "../authorization/authorization.types";
import { can } from "../authorization/permission-policy";

/** 组织名称长度约束（需求 ORG-01：可修改；1~100 字符） */
export const ORGANIZATION_NAME_MAX_LENGTH = 100;

export function normalizeOrganizationName(name: string): string {
	return name.trim();
}

export function isValidOrganizationName(name: string): boolean {
	const normalized = normalizeOrganizationName(name);
	return normalized.length > 0 && normalized.length <= ORGANIZATION_NAME_MAX_LENGTH;
}

/**
 * capabilities 全量映射（技术方案 §7.2 GET /organizations/current）：
 * 全部权限点的布尔表，供前端渲染按钮（后端真源，前端不得复制角色逻辑）。
 */
export function buildCapabilities(
	role: OrganizationRole,
): Record<Permission, boolean> {
	const result = {} as Record<Permission, boolean>;
	for (const permission of PERMISSIONS) {
		result[permission] = can(role, permission);
	}
	return result;
}

// ─────────────────────────────────────────────────────────────
// W19 成员生命周期规则（需求 MEM-02 / ORG-03.3；技术方案 §6.3）
// ─────────────────────────────────────────────────────────────

/** 最后 Owner 保护（ORG-03.3 / §6.3）：目标为组织唯一活跃 Owner 时禁止
 * 退出/移除/降权——必须先转移所有权或删除组织 */
export function isLastActiveOwner(
	activeOwnerCount: number,
	targetRole: string,
	targetStatus: string,
): boolean {
	return (
		activeOwnerCount <= 1 && targetRole === "OWNER" && targetStatus === "ACTIVE"
	);
}

/** 角色形状校验：委托授权层唯一真源（可分配性由 canManage 判定） */
export function isValidRole(role: string): boolean {
	return isOrganizationRole(role);
}
