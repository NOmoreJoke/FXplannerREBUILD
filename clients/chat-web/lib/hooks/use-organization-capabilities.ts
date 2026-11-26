"use client";

import { useCallback, useMemo } from "react";
import type { components } from "@/lib/api/schema.gen";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useCurrentOrganization } from "@/lib/hooks/use-organizations";

/**
 * 组织权限消费层（技术方案 §6.1「前端从后端 capabilities 获取展示能力」、§10.1；
 * Goal #3B W28）：账本交互与数据权利按钮的唯一权限入口。
 *
 * 纪律（铁律）：
 * - 权限真源只有后端下发的 capabilities 布尔表。前端**不复制角色逻辑**，本文件只做
 *   「按键取布尔值」，不做任何角色推断；
 * - fail-closed：未选组织 / 加载中 / 加载失败 / 键缺失 / 值非 true，can(...) 一律 false
 *   ——写按钮宁可晚出现，不可误闪现；
 * - role 与 capabilities 只存在于 React Query 内存，**严禁**写入 localStorage /
 *   sessionStorage / organization-store：持久化会被篡改，且降权后过期。
 *   刷新页面、切组织、聚焦窗口都会重新拉取，以后端最新角色为准；
 * - capabilities 只控制显示，不是授权防线——每个写接口后端都强制 @RequiresPermission。
 */

type Schemas = components["schemas"];

/** 组织角色（后端五角色枚举） */
export type OrganizationRole = Schemas["OrganizationCurrentDto"]["role"];

/** 组织数据请求锁摘要（进行中的 CLEAR / DELETION；EXPORT 不锁） */
export type OrganizationLock = Schemas["OrganizationLockDto"];

/**
 * 前端消费的权限点键。键名以后端 authorization.types.ts 的 PERMISSIONS 与
 * permission-policy.ts 的角色映射为唯一真源，这里只列出账本交互与数据权利门控
 * 用到的子集；新增门控先确认后端已有同名权限点。
 */
export const ORGANIZATION_PERMISSIONS = [
	"organization.read",
	"organization.delete",
	"settings.update",
	"plan.create",
	"plan.adjust",
	"transaction.create",
	"usage.create",
	"correction.preview",
	"correction.apply",
	"data.export",
	"data.clear",
	"agent.use",
	"agent.business_read",
	"agent.draft",
] as const;

export type OrganizationPermission = (typeof ORGANIZATION_PERMISSIONS)[number];

/** 角色的展示文案：只用于把后端下发的 role 讲给人听，不参与任何判定 */
export const ORGANIZATION_ROLE_LABEL: Record<OrganizationRole, string> = {
	OWNER: "所有者",
	ADMIN: "管理员",
	FINANCE: "财务",
	OPERATOR: "操作员",
	VIEWER: "查看者",
};

export interface OrganizationCapabilities {
	/**
	 * 后端下发的权限布尔表，原样透传不重算；未选组织 / 加载中 / 加载失败为空表。
	 * 键为后端全量权限点，读取一律经 can(permission)。
	 */
	capabilities: Readonly<Record<string, boolean>>;
	/** 权限判定（fail-closed，见文件头）；引用稳定，可安全放进依赖数组 */
	can: (permission: OrganizationPermission) => boolean;
	/** 已选组织但详情未返回（含切换组织后的重拉期）；未选组织为 false */
	isLoading: boolean;
	/** 当前组织详情加载失败（网络 / 5xx）；此时 can 全 false，由消费方决定重试或降级 */
	isError: boolean;
	/** 当前选中的组织 id；null = 未选组织（0 组织 / 多组织未选） */
	organizationId: string | null;
	organizationName: string | null;
	role: OrganizationRole | null;
	/** 当前组织是否已完成建账；未知（未选 / 加载中 / 失败）为 false */
	onboardingCompleted: boolean;
	/** 组织本位币（建账时锁定）；未建账或未知为 null */
	baseCurrency: string | null;
	/** 记账起点；未建账或已清空为 null */
	ledgerStartedAt: string | null;
	/** 组织数据请求锁摘要；未知为 null */
	dataRequestLock: OrganizationLock | null;
	/** 存在进行中的组织 CLEAR / DELETION（导出不锁） */
	isDataLocked: boolean;
	/**
	 * 组织删除处理中。与 CLEAR 不同，删除锁下连组织上下文端点的 GET 都会被
	 * 403 拦截——账本查询必须先静默，否则每个页面都靠 403 硬跳转。
	 */
	isDeletionLocked: boolean;
}

/** 未就绪时的空权限表：模块级常量，引用稳定 */
const NO_CAPABILITIES: Readonly<Record<string, boolean>> = Object.freeze({});

export function useOrganizationCapabilities(): OrganizationCapabilities {
	const organizationId = useActiveOrgId();
	const currentQuery = useCurrentOrganization();
	// 详情按组织 id 分桶；这里再核对一次 id，杜绝把别的组织的详情当成当前组织的权限
	const current =
		organizationId !== null && currentQuery.data?.id === organizationId
			? currentQuery.data
			: undefined;

	const capabilities: Readonly<Record<string, boolean>> =
		current?.capabilities ?? NO_CAPABILITIES;
	// 严格 === true：字符串 "true"、1 之类的畸变值一律不算授权
	const can = useCallback(
		(permission: OrganizationPermission) => capabilities[permission] === true,
		[capabilities],
	);

	const isLoading = organizationId !== null && currentQuery.isPending;
	const isDataLocked = current?.dataRequestLock.active === true;

	return useMemo(
		() => ({
			capabilities,
			can,
			isLoading,
			isError: currentQuery.isError,
			organizationId,
			organizationName: current?.name ?? null,
			role: current?.role ?? null,
			onboardingCompleted: current?.onboardingCompleted === true,
			baseCurrency: current?.baseCurrency ?? null,
			ledgerStartedAt: current?.ledgerStartedAt ?? null,
			dataRequestLock: current?.dataRequestLock ?? null,
			isDataLocked,
			isDeletionLocked: isDataLocked && current?.dataRequestLock.type === "DELETION",
		}),
		[
			capabilities,
			can,
			isLoading,
			currentQuery.isError,
			organizationId,
			current,
			isDataLocked,
		],
	);
}

/**
 * 账本查询闸门：当前组织是否具备发起账本类 GET（/settings、/reminders、/home/*）的前提。
 * 查询降噪（技术方案 §10.3、DEBT-06）的唯一判定点，各消费方不得各写一份。
 *
 * - no-organization：未选组织——不发带空头或带错头的请求；
 * - loading：组织详情未返回——建账态与锁态未知，先不发；
 * - not-onboarded：未建账——这些端点必然 409 ONBOARDING_NOT_COMPLETED；
 * - deletion-locked：组织删除处理中——这些 GET 必然 403 ORGANIZATION_DATA_LOCKED；
 * - ready：可以发。
 *
 * 关于 CLEAR 锁：清空冷静期（PENDING）内 GET 放行、只有写被拦，所以 CLEAR 锁不算
 * 闸门条件——用户仍可浏览，写操作由后端 403 引导去进度页。
 *
 * 组织详情读取失败时返回 ready：闸门只是降噪优化而不是权限防线，判定依据拿不到时
 * 退回「让业务端点自己裁决」（失败照常走错误态 + 重试），不让页面卡在永久加载。
 */
export type LedgerQueryGate =
	| "no-organization"
	| "loading"
	| "not-onboarded"
	| "deletion-locked"
	| "ready";

/** 闸门判定只依赖组织上下文的这五个事实（纯函数，零 IO，可直接单测） */
export type LedgerQueryGateInput = Pick<
	OrganizationCapabilities,
	| "organizationId"
	| "isLoading"
	| "isError"
	| "onboardingCompleted"
	| "isDeletionLocked"
>;

export function resolveLedgerQueryGate(
	caps: LedgerQueryGateInput,
): LedgerQueryGate {
	if (caps.organizationId === null) return "no-organization";
	if (caps.isLoading) return "loading";
	if (caps.isError) return "ready";
	if (!caps.onboardingCompleted) return "not-onboarded";
	if (caps.isDeletionLocked) return "deletion-locked";
	return "ready";
}

export function useLedgerQueryGate(): LedgerQueryGate {
	return resolveLedgerQueryGate(useOrganizationCapabilities());
}
