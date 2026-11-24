"use client";

import { useOrganizationStore } from "@/lib/stores/organization-store";

/**
 * 当前组织 id 选择器（ToB W20）：组织作用域 hooks 统一经此读取；
 * null = 未选择组织（业务查询 enabled 门控关闭，不发带空头业务请求）。
 */
export function useActiveOrgId(): string | null {
	return useOrganizationStore((s) => s.activeOrganizationId);
}
