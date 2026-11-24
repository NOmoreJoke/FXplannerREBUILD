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
	/**
	 * 当前选择被（重新）设置的时刻（毫秒；仅内存、不持久化）。
	 * 路由分流据此区分两类选择：
	 * - 从 localStorage 恢复的选择：时刻为 0，列表一到位即校验，不在列表里就清除；
	 * - 本会话内由应用设置的选择（切换/接受邀请/新建组织）：列表缓存此刻可能
	 *   还不含该组织（已失效、重拉在途），必须等列表数据新于该时刻再校验——
	 *   否则刚加入的组织会被当成失效选择立刻清掉。
	 */
	activeOrganizationSetAt: number;
	/** 设置当前组织（登录后按服务端有效 Membership 路由时调用） */
	setActiveOrganization: (organizationId: string | null) => void;
	/**
	 * 清除选择（选择失效 / 退出组织后的回落）。**保留**会话级拒绝集合——
	 * 被服务端拒绝过的组织仍不得被自动选回（否则陷入「清除 → 自动选回 → 再 404」循环）。
	 */
	clearActiveOrganization: () => void;
	/**
	 * 会话级重置（评审 R2-I10）：换账号 / 登出 / 401 时调用——选择与会话级拒绝集合
	 * 一并清空。拒绝集合是「上一个账号在本会话被拒的组织」，新账号不得继承：
	 * 否则新账号自己的组织可能因上一个账号的拒绝记录而无法被自动选中。
	 * （统一入口见 lib/auth/session-reset.ts，业务代码不要单独调本方法）
	 */
	resetSession: () => void;
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
			activeOrganizationSetAt: 0,
			rejectedOrganizationIds: [],
			setActiveOrganization: (organizationId) =>
				set((state) => ({
					activeOrganizationId: organizationId,
					activeOrganizationSetAt: organizationId === null ? 0 : Date.now(),
					// 显式选择即解除该组织的拒绝态（本会话内被移出后重新接受邀请的场景）。
					// 路由分流的自动选中只选未被拒绝的组织，不会借此绕回拒绝态；
					// 若服务端再次拒绝，会重新记入。
					rejectedOrganizationIds:
						organizationId === null
							? state.rejectedOrganizationIds
							: state.rejectedOrganizationIds.filter(
									(id) => id !== organizationId,
								),
				})),
			clearActiveOrganization: () =>
				set({ activeOrganizationId: null, activeOrganizationSetAt: 0 }),
			resetSession: () =>
				set({
					activeOrganizationId: null,
					activeOrganizationSetAt: 0,
					rejectedOrganizationIds: [],
				}),
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
					activeOrganizationSetAt:
						state.activeOrganizationId === organizationId
							? 0
							: state.activeOrganizationSetAt,
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
