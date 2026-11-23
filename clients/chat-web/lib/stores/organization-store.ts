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
	/**
	 * 本会话内被服务端判定不可访问的组织（400/404 组织上下文失效）。
	 * 仅内存、不持久化；路由分流的自动选中与选择校验都跳过它们——否则
	 * 单组织用户被移出后会陷入「清除选择 → 自动选回 → 再 404」的循环。
	 */
	rejectedOrganizationIds: string[];
	/** 设置当前组织（登录后按服务端有效 Membership 路由时调用） */
	setActiveOrganization: (organizationId: string | null) => void;
	/** 清除选择（登出 / 401：换账号登录不得继承上一个账号的组织） */
	clearActiveOrganization: () => void;
	/**
	 * 服务端拒绝某组织的上下文（评审 I-18）：记入拒绝集合；仅当它仍是当前
	 * 选择时才清除——旧组织的迟到响应不得清掉用户刚切换到的新组织。
	 */
	rejectOrganizationContext: (organizationId: string | null) => void;
}

export const useOrganizationStore = create<OrganizationStore>()(
	persist(
		(set) => ({
			activeOrganizationId: null,
			rejectedOrganizationIds: [],
			setActiveOrganization: (organizationId) =>
				set({ activeOrganizationId: organizationId }),
			clearActiveOrganization: () => set({ activeOrganizationId: null }),
			rejectOrganizationContext: (organizationId) =>
				set((state) => ({
					rejectedOrganizationIds:
						organizationId !== null &&
						!state.rejectedOrganizationIds.includes(organizationId)
							? [...state.rejectedOrganizationIds, organizationId]
							: state.rejectedOrganizationIds,
					activeOrganizationId:
						state.activeOrganizationId === organizationId
							? null
							: state.activeOrganizationId,
				})),
		}),
		{
			name: "active-organization",
			partialize: (state) => ({
				activeOrganizationId: state.activeOrganizationId,
			}),
		},
	),
);
