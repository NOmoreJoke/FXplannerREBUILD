"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { useCurrentOrganization, useLeaveOrganization } from "@/lib/hooks/use-organizations";

/**
 * 退出组织（需求 MEM-02.5；外部评审前端批次补入口）：
 * - 仅非 Owner 成员可见——最后 Owner 必须先转移所有权（后端 409 LAST_OWNER_REQUIRED）；
 * - 高危操作：行内二次确认（键盘可达），成功后回到首页，由组织路由分流接管
 *   （剩余单组织自动选中 / 多组织进入选择页）。
 * 组件不裸写 useEffect/setTimeout（状态流 + react-query 驱动）。
 */
export function LeaveOrganizationButton() {
	const { data: current } = useCurrentOrganization();
	const leave = useLeaveOrganization();
	const router = useRouter();
	const [confirming, setConfirming] = useState(false);

	// Owner 不提供退出入口（避免暴露后端必 409 的操作）
	if (!current || current.role === "OWNER") {
		return null;
	}

	const confirmLeave = () => {
		// 导航不能放在 mutate 的调用点回调里（评审 R3-I02）：useLeaveOrganization 的
		// hook 级 onSuccess 同步清空组织选择，受保护区布局随即整屏替换、卸载本组件；
		// 调用点回调只向仍挂载的观察者派发，router.replace 永不执行——用户停留在
		// 已无权访问的成员页。mutateAsync 的 Promise 与挂载态无关；失败态由 leave.error
		// 展示，这里只需接住拒绝，避免未处理的 Promise 拒绝
		void leave
			.mutateAsync()
			.then(() => router.replace("/home"), () => {});
	};

	return (
		<section
			data-testid="leave-organization"
			className="space-y-2 rounded-xl border border-border p-4"
		>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<h2 className="text-sm font-semibold text-foreground">退出组织</h2>
					<p className="mt-1 text-xs text-muted-foreground">
						退出后将失去「{current.name}」的全部访问权限；如需重新加入，请让管理员再次邀请。
					</p>
				</div>
				{confirming ? (
					<span className="inline-flex shrink-0 items-center gap-2">
						<button
							type="button"
							disabled={leave.isPending}
							onClick={confirmLeave}
							className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
							data-testid="leave-organization-confirm"
						>
							{leave.isPending ? "退出中…" : "确认退出"}
						</button>
						<button
							type="button"
							disabled={leave.isPending}
							onClick={() => setConfirming(false)}
							className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-ink-500"
						>
							取消
						</button>
					</span>
				) : (
					<button
						type="button"
						onClick={() => setConfirming(true)}
						className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-ink-500 transition-colors hover:bg-muted"
						data-testid="leave-organization-entry"
					>
						<LogOut className="size-3.5" aria-hidden />
						退出组织
					</button>
				)}
			</div>
			{leave.error && (
				<p role="alert" className="text-xs text-red-600">
					{leave.error.message}
				</p>
			)}
		</section>
	);
}
