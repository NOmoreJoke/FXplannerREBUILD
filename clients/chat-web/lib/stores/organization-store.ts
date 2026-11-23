import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * 组织上下文运行时状态（ToB R1 W20；技术方案 §10.1）。
 *
 * 职责边界（严格）：
 * - 仅保存「当前选中的组织 id」；null = 未选择（多组织用户进入选择态）；
 * - **严禁持久化 role / capabilities**（权限真源在后端 capabilities Map，
 *   持久化会被篡改且降权后过期——AUTH-02 前端侧纪律）；
 * - 切换组织的缓存清理/请求中止在 use-organizations.switchOrganization
 *   （需要 QueryClient，不放 store）。
 *
 * 持久化：仅 activeOrganizationId 落 localStorage（"active-organization"，
 * 记住的只是选择，不构成访问凭证——每次请求后端实时校验 Membership）。
 */
interface OrganizationStore {
	/** 当前选中组织 id；null = 未选择（新建/选择引导态） */
	activeOrganizationId: string | null;
	/** 设置当前组织（登录后按服务端有效 Membership 路由时调用） */
	setActiveOrganization: (organizationId: string | null) => void;
	/** 清除选择（400/404 组织上下文失效时由 apiClient 调用） */
	clearActiveOrganization: () => void;
}

export const useOrganizationStore = create<OrganizationStore>()(
	persist(
		(set) => ({
			activeOrganizationId: null,
			setActiveOrganization: (organizationId) =>
				set({ activeOrganizationId: organizationId }),
			clearActiveOrganization: () => set({ activeOrganizationId: null }),
		}),
		{
			name: "active-organization",
			partialize: (state) => ({
				activeOrganizationId: state.activeOrganizationId,
			}),
		},
	),
);
