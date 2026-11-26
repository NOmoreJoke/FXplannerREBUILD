"use client";

import { useState } from "react";
import Link from "next/link";
import {
	Building2,
	Download,
	LogOut,
	Trash2,
	UserRound,
	UserX,
	Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DATA_REQUESTS_PAGE_PATH } from "@/lib/api/client";
import {
	ORGANIZATION_ROLE_LABEL,
	useOrganizationCapabilities,
} from "@/lib/hooks/use-organization-capabilities";
import {
	useOrganizationCurrentRequest,
	usePersonalCurrentRequest,
} from "@/lib/hooks/use-data-request";
import { useAuthStore } from "@/lib/stores/auth-store";
import { ClearFlow } from "./clear-flow";
import { DeletionFlow } from "./deletion-flow";
import { ExportFlow } from "./export-flow";
import { OrganizationDeletionFlow } from "./organization-deletion-flow";
import { RequestPanelError, RequestPanelLoading, RequestProgress } from "./request-progress";
import { isBlockingRequest } from "./request-copy";

/**
 * 设置页「账号与数据」区（技术方案 §9.2；Goal #3B W28 双域拆分）：两块数据权利相互独立，
 * 分卡片呈现，不让用户误以为注销账号会动到组织账本。
 *
 * 1. 个人账号与数据（个人域，与组织无关，任何角色都可操作）：
 *    退出登录、导出个人数据（不含组织账本）、注销个人账号；
 * 2. 当前组织数据（组织域，按当前组织的角色能力显隐）：
 *    导出组织账本（data.export）、清空组织账本（data.clear 且已建账）、
 *    删除当前组织（仅 organization.delete，即所有者）。
 *
 * 有进行中请求时以进度卡替代新入口（互斥由后端保证，前端同步隐藏）；
 * 入口按后端 capabilities 显隐——无权角色不会看到一个点下去必然 403 的按钮。
 */

type PersonalFlow = "export" | "deletion";
type OrganizationFlow = "export" | "clear" | "delete";

export function AccountDataSection({ onLogout }: { onLogout: () => void }) {
	return (
		<div data-testid="account-data-section" className="mt-6 space-y-6">
			<header className="flex items-end justify-between gap-4">
				<div>
					<h2 className="text-base font-bold text-foreground">账号与数据</h2>
					<p className="mt-1 text-xs leading-5 text-muted-foreground">
						个人数据权利与组织数据权利相互独立：注销个人账号不会删除组织账本，
						删除组织也不会删除任何成员的个人账号。
					</p>
				</div>
				<Link
					href={DATA_REQUESTS_PAGE_PATH}
					data-testid="account-data-progress-link"
					className="shrink-0 text-xs font-medium text-mint-700 underline-offset-2 hover:underline"
				>
					查看处理进度
				</Link>
			</header>
			<PersonalDataSection onLogout={onLogout} />
			<OrganizationDataSection />
		</div>
	);
}

function SectionHeader({
	icon: Icon,
	title,
	description,
	badge,
}: {
	icon: typeof UserRound;
	title: string;
	description: string;
	badge?: React.ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-start justify-between gap-3">
			<div className="flex items-start gap-3">
				<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-mint-100">
					<Icon className="size-5 text-mint-700" aria-hidden="true" />
				</div>
				<div>
					<h3 className="text-base font-bold text-foreground">{title}</h3>
					<p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
				</div>
			</div>
			{badge}
		</div>
	);
}

function ActionRow({
	icon: Icon,
	label,
	description,
	action,
	testId,
	onClick,
}: {
	icon: typeof LogOut;
	label: string;
	description: string;
	action: string;
	testId: string;
	onClick: () => void;
}) {
	return (
		<div className="flex items-center justify-between gap-4 py-4">
			<div className="flex min-w-0 items-start gap-2.5">
				<Icon className="mt-0.5 size-4 shrink-0 text-ink-500" aria-hidden="true" />
				<div className="min-w-0">
					<p className="text-sm text-foreground">{label}</p>
					<p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
				</div>
			</div>
			<Button
				variant="outline"
				className="shrink-0 bg-white"
				data-testid={testId}
				onClick={onClick}
			>
				{action}
			</Button>
		</div>
	);
}

/** 个人账号与数据：退出登录 + 个人导出 + 注销个人账号 */
function PersonalDataSection({ onLogout }: { onLogout: () => void }) {
	const userEmail = useAuthStore((state) => state.user?.email ?? "");
	const current = usePersonalCurrentRequest();
	const [activeFlow, setActiveFlow] = useState<PersonalFlow | null>(null);
	// 本人名下有进行中的个人请求 → 以进度卡替代新入口（退出登录始终可用）
	const blocked = current.data ? isBlockingRequest(current.data) : false;

	return (
		<section
			data-testid="personal-data-section"
			className="rounded-2xl border border-border bg-white p-6"
		>
			<SectionHeader
				icon={UserRound}
				title="个人账号与数据"
				description="属于你本人，与组织无关：不受组织建账状态或组织角色影响，任何人都可操作。"
			/>

			{current.isPending ? (
				<div className="mt-5">
					<RequestPanelLoading />
				</div>
			) : current.isError ? (
				<div className="mt-5">
					<RequestPanelError
						testId="personal-data-request-error"
						error={current.error}
						onRetry={() => void current.refetch()}
					/>
				</div>
			) : (
				<div className="mt-5">
					{current.data && <RequestProgress view={current.data} />}
					<div className="divide-y divide-border">
						<ActionRow
							icon={LogOut}
							label="退出登录"
							description="结束当前登录，不影响任何数据"
							action="退出"
							testId="settings-logout"
							onClick={onLogout}
						/>
						{/* 已完成 / 已撤回的请求不阻塞新入口（互斥由后端终审） */}
						{!blocked && (
							<ActionRow
								icon={Download}
								label="导出个人数据"
								description="打包一份个人数据副本，不含任何组织的账本明细"
								action="导出"
								testId="account-data-export"
								onClick={() => setActiveFlow("export")}
							/>
						)}
						{!blocked && (
							<ActionRow
								icon={UserX}
								label="注销个人账号"
								description="关闭账号并删除个人数据；所在组织的共享账本不会被删除"
								action="注销"
								testId="account-data-delete"
								onClick={() => setActiveFlow("deletion")}
							/>
						)}
					</div>
				</div>
			)}

			{/* 流程对话框（共享 open 状态，互斥展示） */}
			<ExportFlow
				scope="PERSONAL"
				open={activeFlow === "export"}
				onOpenChange={(open) => !open && setActiveFlow(null)}
				target={userEmail}
			/>
			<DeletionFlow
				open={activeFlow === "deletion"}
				onOpenChange={(open) => !open && setActiveFlow(null)}
				target={userEmail}
			/>
		</section>
	);
}

/** 当前组织数据：导出 / 清空 / 删除，按当前组织的角色能力显隐 */
function OrganizationDataSection() {
	const userEmail = useAuthStore((state) => state.user?.email ?? "");
	const caps = useOrganizationCapabilities();
	const current = useOrganizationCurrentRequest();
	const [activeFlow, setActiveFlow] = useState<OrganizationFlow | null>(null);

	// 入口门控：导出与清空都要求组织已建账（后端同样以此为准），权限点各自独立
	const canExport = caps.onboardingCompleted && caps.can("data.export");
	const canClear = caps.onboardingCompleted && caps.can("data.clear");
	const canDelete = caps.can("organization.delete");
	// 组织级互斥：任一成员发起的组织请求进行中 → 以进度卡替代新入口
	const blocked = current.data ? isBlockingRequest(current.data) : false;
	const hasEntries = canExport || canClear || canDelete;

	let body: React.ReactNode;
	if (caps.organizationId === null) {
		body = (
			<p className="mt-5 text-sm text-muted-foreground">
				尚未选择组织，选择后可管理该组织的数据。
			</p>
		);
	} else if (caps.isLoading || current.isPending) {
		body = (
			<div className="mt-5">
				<RequestPanelLoading />
			</div>
		);
	} else if (current.isError) {
		body = (
			<div className="mt-5">
				<RequestPanelError
					testId="organization-data-request-error"
					error={current.error}
					onRetry={() => void current.refetch()}
				/>
			</div>
		);
	} else {
		body = (
			<div className="mt-5">
				{current.data && <RequestProgress view={current.data} />}
				{!blocked && hasEntries && (
					<div className="divide-y divide-border">
						{canExport && (
							<ActionRow
								icon={Download}
								label="导出组织账本"
								description="打包当前组织的共享账本（CSV 表格与阅读说明）"
								action="导出"
								testId="organization-data-export"
								onClick={() => setActiveFlow("export")}
							/>
						)}
						{canClear && (
							<ActionRow
								icon={Trash2}
								label="清空组织账本"
								description="清空当前组织的账本记录，保留组织、成员账号与本位币；7 日内可撤回"
								action="清空"
								// 沿用既有 testid（E2E 12-account-data 以它定位清空入口）；清空自 W26 起属组织域
								testId="account-data-clear"
								onClick={() => setActiveFlow("clear")}
							/>
						)}
						{canDelete && (
							<ActionRow
								icon={Building2}
								label="删除当前组织"
								description="删除该组织与共享账本，不删除任何成员的个人账号；7 日内可撤回"
								action="删除"
								testId="organization-data-delete"
								onClick={() => setActiveFlow("delete")}
							/>
						)}
					</div>
				)}
				{!blocked && !hasEntries && (
					<p
						data-testid="organization-data-readonly-note"
						className="flex items-start gap-2 rounded-xl border border-dashed border-border px-4 py-4 text-xs leading-5 text-muted-foreground"
					>
						<Users className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						当前角色只能查看组织账本：导出需财务及以上，清空需管理员及以上，删除组织仅限所有者。
					</p>
				)}
			</div>
		);
	}

	return (
		<section
			data-testid="organization-data-section"
			className="rounded-2xl border border-border bg-white p-6"
		>
			<SectionHeader
				icon={Building2}
				title="当前组织数据"
				description="只影响当前组织的共享账本，不影响你所在的其他组织，也不影响任何成员的个人账号。"
				badge={
					caps.organizationName ? (
						<span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-ink-600">
							{caps.organizationName}
							{caps.role ? ` · ${ORGANIZATION_ROLE_LABEL[caps.role]}` : ""}
						</span>
					) : undefined
				}
			/>
			{body}

			<ExportFlow
				scope="ORGANIZATION"
				open={activeFlow === "export"}
				onOpenChange={(open) => !open && setActiveFlow(null)}
				target={userEmail}
			/>
			<ClearFlow
				open={activeFlow === "clear"}
				onOpenChange={(open) => !open && setActiveFlow(null)}
				target={userEmail}
				organizationName={caps.organizationName}
			/>
			<OrganizationDeletionFlow
				open={activeFlow === "delete"}
				onOpenChange={(open) => !open && setActiveFlow(null)}
				target={userEmail}
				organizationName={caps.organizationName}
			/>
		</section>
	);
}
