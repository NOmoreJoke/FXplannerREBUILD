"use client";

import { useState } from "react";
import { Download, LogOut, Trash2, UserX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ClearFlow } from "./clear-flow";
import { DeletionFlow } from "./deletion-flow";
import { ExportFlow } from "./export-flow";
import { RequestProgress } from "./request-progress";
import { useCurrentRequest } from "@/lib/hooks/use-data-request";
import { useAuthStore } from "@/lib/stores/auth-store";

/**
 * 设置页「账号与数据」区（account-data 技术方案 §8）：
 * 退出登录 + 三项数据权利操作入口；有进行中请求（含可下载导出）时
 * 以进度卡展示并锁定新入口（互斥由后端保证，前端同步隐藏）。
 */

const ENTRIES = [
	{
		key: "export",
		icon: Download,
		label: "导出个人数据",
		description: "打包带走一份完整的数据副本",
		testId: "account-data-export",
	},
	{
		key: "clear",
		icon: Trash2,
		label: "清空业务记录",
		description: "删除账本，保留账号，从零重新开始",
		testId: "account-data-clear",
	},
	{
		key: "deletion",
		icon: UserX,
		label: "注销账号",
		description: "关闭账号并按期限清理全部个人数据",
		testId: "account-data-delete",
	},
] as const;

type EntryKey = (typeof ENTRIES)[number]["key"];

export function AccountDataSection({ onLogout }: { onLogout: () => void }) {
	const userEmail = useAuthStore((state) => state.user?.email ?? "");
	const [activeFlow, setActiveFlow] = useState<EntryKey | null>(null);
	// 有进行中请求或可下载导出 → 展示进度卡；否则展示三入口
	const current = useCurrentRequest();

	return (
		<section className="mt-6 rounded-2xl border border-border bg-white p-6" data-testid="account-data-section">
			<h2 className="text-base font-bold text-foreground">账号与数据</h2>

			{current.data ? (
				<div className="mt-5 space-y-4">
					<RequestProgress view={current.data} />
					{/* 已完成/已撤回的请求不阻塞新入口（互斥由后端终审） */}
					{!isBlocking(current.data) && (
						<EntryRows disabled={false} onOpen={setActiveFlow} />
					)}
				</div>
			) : (
				<div className="mt-5 divide-y divide-border">
					<div className="flex items-center justify-between py-4">
						<div className="flex items-center gap-2.5">
							<LogOut className="size-4 text-ink-500" aria-hidden="true" />
							<div>
								<p className="text-sm text-foreground">退出登录</p>
							</div>
						</div>
						<Button
							variant="outline"
							data-testid="settings-logout"
							className="bg-white"
							onClick={onLogout}
						>
							退出
						</Button>
					</div>
					<EntryRows disabled={false} onOpen={setActiveFlow} />
				</div>
			)}

			{/* 流程对话框（共享 open 状态，互斥展示） */}
			<ExportFlow
				open={activeFlow === "export"}
				onOpenChange={(open) => !open && setActiveFlow(null)}
				target={userEmail}
				onSubmitted={() => toast.success("导出完成，可在下方下载")}
			/>
			<ClearFlow
				open={activeFlow === "clear"}
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

/** 请求是否阻塞新入口：PENDING/PROCESSING/FAILED（可下载导出不阻塞重复导出以外的入口） */
function isBlocking(view: {
	status: string;
	type: string;
}): boolean {
	return ["PENDING", "PROCESSING", "FAILED"].includes(view.status);
}

function EntryRows({
	disabled,
	onOpen,
}: {
	disabled: boolean;
	onOpen: (key: EntryKey) => void;
}) {
	return (
		<>
			{ENTRIES.map(({ key, icon: Icon, label, description, testId }) => (
				<div className="flex items-center justify-between py-4" key={key}>
					<div className="flex items-center gap-2.5">
						<Icon className="size-4 text-ink-500" aria-hidden="true" />
						<div>
							<p className="text-sm text-foreground">{label}</p>
							<p className="text-xs text-muted-foreground">{description}</p>
						</div>
					</div>
					<Button
						variant="outline"
						className="bg-white"
						data-testid={testId}
						disabled={disabled}
						onClick={() => onOpen(key)}
					>
						{key === "export" ? "导出" : key === "clear" ? "清空" : "注销"}
					</Button>
				</div>
			))}
		</>
	);
}
