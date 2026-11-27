"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { CircleAlert, Plus } from "lucide-react";
import { accountsApi, type AccountListItem } from "@/lib/api/accounts";
import { getCurrencyName } from "@/lib/api/currencies";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

/**
 * 外汇账户列表页（changes/account-module/技术方案.md §5.2，原型 l3R09）
 *
 * 瘦壳：useQuery 调 GET /accounts 渲染按币种账户表格。
 * 金额一律原样渲染接口字符串（禁止千分位/精度裁剪，保障 E2E toContainText 精确断言）；
 * 空态引导去录入；认证守卫在 (protected)/layout.tsx（勿在此重复）。
 */
export default function AccountsPage() {
	// 组织作用域缓存键 + 未选组织不发业务请求（评审 R2-I07：键不含组织时，
	// 切换组织的缓存清理不会通知挂载态的观察者）
	const orgId = useActiveOrgId();
	const { can } = useOrganizationCapabilities();
	const canCreateTransaction = can("transaction.create");
	const query = useQuery({
		queryKey: withOrgScope(orgId, queryKeys.accounts.list()),
		queryFn: () => accountsApi.list(),
		enabled: orgId !== null,
	});

	if (query.isLoading) {
		return <AccountsSkeleton />;
	}

	if (query.isError) {
		return <AccountsError onRetry={() => query.refetch()} />;
	}

	if (!query.data) {
		return null; // 不可达：非 loading 非 error 时 data 必已就绪（类型收窄）
	}

	const isEmpty = query.data.accounts.length === 0;

	return (
		<div className="mx-auto max-w-5xl px-8 py-6">
			<header className="mb-6 flex items-start justify-between">
				<div>
					<h1 className="text-xl font-bold text-foreground">外汇账户</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						按币种查看持仓、已分配与未分配余额。
					</p>
				</div>
				{canCreateTransaction ? (
					<Link
						href="/transactions/new"
						data-testid="accounts-create-transaction"
						className={buttonVariants({
							className: "bg-mint-700 text-white hover:bg-mint-700/90",
						})}
					>
						<Plus className="size-4" />
						录入换汇
					</Link>
				) : null}
			</header>

			{isEmpty ? (
				<AccountsEmpty canCreateTransaction={canCreateTransaction} />
			) : (
				<AccountsTable accounts={query.data.accounts} />
			)}
		</div>
	);
}

/** 账户表格：金额原样渲染接口字符串，行内「查看账户」进入详情 */
function AccountsTable({ accounts }: { accounts: AccountListItem[] }) {
	return (
		<div className="overflow-hidden rounded-2xl border border-border bg-white">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>币种</TableHead>
						<TableHead>余额</TableHead>
						<TableHead>已分配</TableHead>
						<TableHead>未分配余额</TableHead>
						<TableHead className="text-right">操作</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{accounts.map((account) => (
						<TableRow key={account.currencyCode}>
							<TableCell>
								<span className="font-semibold text-foreground">
									{account.currencyCode}
								</span>
								<span className="ml-2 text-xs text-muted-foreground">
									{getCurrencyName(account.currencyCode) ?? ""}
								</span>
							</TableCell>
							<TableCell className="font-medium text-foreground tabular-nums">
								{account.balance}
							</TableCell>
							<TableCell className="font-medium text-foreground tabular-nums">
								{account.allocatedAmount}
							</TableCell>
							<TableCell className="font-medium text-foreground tabular-nums">
								{account.unallocatedAmount}
							</TableCell>
							<TableCell className="text-right">
								<Link
									href={`/accounts/${account.currencyCode}`}
									className="text-sm font-medium text-mint-700 hover:underline"
								>
									查看账户
								</Link>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

/** 空态：引导具备记账权限的成员去录入第一笔换汇 */
function AccountsEmpty({
	canCreateTransaction,
}: {
	canCreateTransaction: boolean;
}) {
	return (
		<div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-white px-8 py-16 text-center">
			<h2 className="text-base font-bold text-foreground">
				还没有任何外汇账户
			</h2>
			<p className="mt-2 max-w-md text-sm text-muted-foreground">
				{canCreateTransaction
					? "录入第一笔换汇后，系统会按币种自动建立账户，汇总持仓与分配情况。"
					: "当前组织尚未建立任何外汇账户。如需录入换汇，请联系具备记账权限的成员。"}
			</p>
			{canCreateTransaction ? (
				<Link
					href="/transactions/new"
					data-testid="accounts-empty-create-transaction"
					className={buttonVariants({
						className: "mt-6 bg-mint-700 text-white hover:bg-mint-700/90",
					})}
				>
					<Plus className="size-4" />
					录入换汇
				</Link>
			) : null}
		</div>
	);
}

/**
 * 整页加载骨架：沿用正常页的区块位置（标题/按钮/表格），避免布局跳动
 * （对齐 home/page.tsx 的 HomeSkeleton 先例）
 */
function AccountsSkeleton() {
	return (
		<div className="mx-auto max-w-5xl px-8 py-6">
			<header className="mb-6 flex items-start justify-between">
				<div className="space-y-2">
					<Skeleton className="h-6 w-24" />
					<Skeleton className="h-3 w-64" />
				</div>
				<Skeleton className="h-9 w-28" />
			</header>
			<Skeleton className="h-64 w-full rounded-2xl" />
		</div>
	);
}

/** 整页错误态：文案 + 重试按钮（react-query refetch），不跳转 */
function AccountsError({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="mx-auto flex max-w-5xl flex-col items-center justify-center px-8 py-24 text-center">
			<CircleAlert className="size-10 text-cream-300" />
			<h1 className="mt-4 text-lg font-bold text-foreground">
				外汇账户加载失败
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				网络异常或服务暂不可用，请稍后重试。
			</p>
			<Button
				className="mt-6 bg-mint-700 text-white hover:bg-mint-700/90"
				onClick={onRetry}
			>
				重试
			</Button>
		</div>
	);
}
