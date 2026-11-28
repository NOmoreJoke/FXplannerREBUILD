"use client";

import { Building2, UserRound } from "lucide-react";
import { ApiError } from "@/lib/api/client";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import {
	ORGANIZATION_ROLE_LABEL,
	useOrganizationCapabilities,
} from "@/lib/hooks/use-organization-capabilities";
import { useOrganizations } from "@/lib/hooks/use-organizations";
import {
	useOrganizationCurrentRequest,
	usePersonalCurrentRequest,
} from "@/lib/hooks/use-data-request";
import {
	RequestPanelError,
	RequestPanelLoading,
	RequestProgress,
} from "./request-progress";

/**
 * 数据请求进度页的两个分区（技术方案 §9.2；Goal #3B W28）。
 *
 * 个人数据请求与组织数据请求是两个数据域，同页并列、各自独立加载：
 * - 个人分区：不依赖组织——0 组织 / 多组织未选 / 账号注销锁定（403
 *   ACCOUNT_PENDING_DELETION 的跳转目的地就是本页）时都必须能读进度并撤回；
 * - 组织分区：只反映**当前组织**的组织域请求，任意有效成员可看进度，
 *   撤回 / 下载按钮按角色能力显隐（见 RequestProgress）。
 *
 * URL 保持纯 /data-requests（不拼 ?scope=）：既有 E2E 按该地址精确匹配，
 * 两个分区本来就同页展示，无需参数分流。
 */

function PanelHeader({
	icon: Icon,
	title,
	description,
}: {
	icon: typeof UserRound;
	title: string;
	description: string;
}) {
	return (
		<div className="flex items-start gap-3">
			<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-ink-100">
				<Icon className="size-5 text-ink-700" aria-hidden="true" />
			</div>
			<div className="min-w-0">
				<h2 className="text-base font-bold text-foreground">{title}</h2>
				<p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
			</div>
		</div>
	);
}

function PanelEmpty({ testId, children }: { testId: string; children: React.ReactNode }) {
	return (
		<div
			data-testid={testId}
			className="rounded-xl border border-dashed border-border px-6 py-8 text-center"
		>
			{children}
		</div>
	);
}

/** 个人数据请求进度：导出个人数据 / 注销个人账号的处理状态与撤回入口 */
export function PersonalRequestPanel() {
	const current = usePersonalCurrentRequest();

	return (
		<section
			data-testid="personal-request-panel"
			className="rounded-2xl border border-border bg-white p-6"
		>
			<PanelHeader
				icon={UserRound}
				title="个人数据请求进度"
				description="导出个人数据、注销个人账号的处理状态。属于你本人，与组织无关，任何角色都可查看与撤回。"
			/>
			<div className="mt-4">
				{current.isPending ? (
					<RequestPanelLoading />
				) : current.isError ? (
					<RequestPanelError
						testId="personal-request-error"
						error={current.error}
						onRetry={() => void current.refetch()}
					/>
				) : current.data ? (
					<RequestProgress view={current.data} />
				) : (
					<PanelEmpty testId="data-requests-empty">
						<p className="text-sm font-bold text-foreground">
							暂无进行中的个人数据请求
						</p>
						<p className="mt-2 text-xs text-muted-foreground">
							可在设置页的「个人账号与数据」区导出个人数据或注销账号。
						</p>
					</PanelEmpty>
				)}
			</div>
		</section>
	);
}

/**
 * 组织数据请求进度。以当前组织 id 为 key 重新挂载：切换组织只刷新这一块（撤回验证
 * 对话框等本地状态随之重置，不会把组织 A 的半截操作带到组织 B），个人进度不受影响。
 */
export function OrganizationRequestPanel() {
	const organizationId = useActiveOrgId();
	return <OrganizationRequestPanelBody key={organizationId ?? "none"} />;
}

function OrganizationRequestPanelBody() {
	const caps = useOrganizationCapabilities();
	const current = useOrganizationCurrentRequest();
	// 未选组织时用组织列表区分「选择还没落地」与「确实没有 / 还没选」，不靠猜
	// （列表与受保护区布局共用同一份缓存，不额外发请求）
	const organizations = useOrganizations();
	// 本人账号注销处理中：组织域端点被账号锁拦截（403 ACCOUNT_PENDING_DELETION）。
	// 这是确定的原因而不是网络故障——如实说明，不给一个重试也重试不好的按钮
	const accountLocked =
		current.error instanceof ApiError &&
		current.error.code === "ACCOUNT_PENDING_DELETION";

	let body: React.ReactNode;
	if (caps.organizationId === null) {
		const listError = organizations.error;
		body = organizations.isLoading ? (
			<RequestPanelLoading />
		) : listError instanceof ApiError &&
			listError.code === "ACCOUNT_PENDING_DELETION" ? (
			<PanelEmpty testId="organization-request-account-locked">
				<p className="text-sm text-muted-foreground">
					账号注销处理中，组织数据请求暂不可查看；撤回注销后恢复。
				</p>
			</PanelEmpty>
		) : organizations.isError ? (
			<RequestPanelError
				testId="organization-request-org-list-error"
				error={organizations.error}
				onRetry={() => void organizations.refetch()}
			/>
		) : (organizations.data?.length ?? 0) === 0 ? (
			<PanelEmpty testId="organization-request-no-org">
				<p className="text-sm text-muted-foreground">
					你还没有加入任何组织。个人数据请求不受影响。
				</p>
			</PanelEmpty>
		) : (
			<PanelEmpty testId="organization-request-no-org">
				<p className="text-sm text-muted-foreground">
					尚未选择组织。可在左侧的切换器里选择组织，查看该组织的数据请求。
				</p>
			</PanelEmpty>
		);
	} else if (caps.isLoading || current.isPending) {
		body = <RequestPanelLoading />;
	} else if (accountLocked) {
		body = (
			<PanelEmpty testId="organization-request-account-locked">
				<p className="text-sm text-muted-foreground">
					账号注销处理中，组织数据请求暂不可查看；撤回注销后恢复。
				</p>
			</PanelEmpty>
		);
	} else if (current.isError) {
		body = (
			<RequestPanelError
				testId="organization-request-error"
				error={current.error}
				onRetry={() => void current.refetch()}
			/>
		);
	} else if (current.data) {
		body = <RequestProgress view={current.data} />;
	} else {
		body = (
			<PanelEmpty testId="data-requests-organization-empty">
				<p className="text-sm font-bold text-foreground">
					当前组织暂无进行中的数据请求
				</p>
				<p className="mt-2 text-xs text-muted-foreground">
					导出、清空组织账本或删除组织的请求会显示在这里。
				</p>
			</PanelEmpty>
		);
	}

	return (
		<section
			data-testid="organization-request-panel"
			className="rounded-2xl border border-border bg-white p-6"
		>
			<PanelHeader
				icon={Building2}
				title="当前组织数据请求进度"
				description={
					caps.organizationName
						? `${caps.organizationName}${caps.role ? ` · 你的角色：${ORGANIZATION_ROLE_LABEL[caps.role]}` : ""}。组织数据请求由成员发起，全体成员共同可见。`
						: "只反映当前组织的请求，不影响你所在的其他组织。"
				}
			/>
			<div className="mt-4">{body}</div>
		</section>
	);
}
