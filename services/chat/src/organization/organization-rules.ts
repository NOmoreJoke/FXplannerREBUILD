/**
 * 组织域纯函数规则（技术方案 §4/§6；Goal #3A W17）。
 * W19 将在此追加成员/邀请不变量；本文件保持零 IO。
 */

import {
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
