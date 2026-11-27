"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { PenLine } from "lucide-react";
import type {
	AccountLedgerItem,
	AccountLedgerItemType,
	AccountLedgerResp,
} from "@/lib/api/accounts";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";
import { Badge } from "@/components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

/**
 * 账户流水表（changes/account-module/技术方案.md §5.2 / §3.6）
 *
 * 纯展示组件：数量/成本一律原样渲染接口金额字符串（禁止千分位/精度裁剪）。
 * - 类型标签映射：初始持仓 / 买入（主色）/ 使用；INITIAL、USAGE 为 M1/M7 预留枚举，
 *   上线前不出现但映射必须就绪（方案 §1.3「契约按终态设计」约束）。
 * - 成本列表头动态本位币：baseCurrency 为 null 时退化为「成本」
 *   （严禁硬编码 CNY，方案 §1.1 裁决 4）。
 * - feeKnown=false 的行显示「费用未明确」标记（doc 05 费用不完整说明义务）。
 * - PURCHASE 行整行可点击跳 /transactions/:id：首个单元格内含真实 <a href>
 *   （stretched link，语义可访问），行级 onClick 兜底保证 Playwright 行内
 *   任意位置可达；INITIAL/USAGE 行不跳转。
 */

/** 流水类型 → 徽标文案与配色（官方术语，对齐 plan-management 方案术语表） */
const TYPE_BADGE: Record<
	AccountLedgerItemType,
	{ label: string; variant: "default" | "outline" }
> = {
	INITIAL: { label: "初始持仓", variant: "outline" },
	PURCHASE: { label: "买入", variant: "default" },
	USAGE: { label: "使用", variant: "outline" },
};

export interface AccountLedgerTableProps {
	/** 账户流水（GET /accounts/:currencyCode/transactions 的 data） */
	ledger: AccountLedgerResp;
}

export function AccountLedgerTable({ ledger }: AccountLedgerTableProps) {
	const { can } = useOrganizationCapabilities();
	const canApplyCorrection = can("correction.apply");
	// 成本币种动态取接口返回的本位币；无 userSettings 时为 null，列头退化为纯「成本」
	const costHeader = ledger.baseCurrency
		? `成本（${ledger.baseCurrency}）`
		: "成本";

	return (
		<div className="overflow-hidden rounded-2xl border border-border bg-white">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>类型</TableHead>
						<TableHead>日期</TableHead>
						<TableHead>数量</TableHead>
						<TableHead>{costHeader}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{ledger.items.length === 0 ? (
						<TableRow>
							<TableCell
								colSpan={4}
								className="h-32 text-center text-sm text-muted-foreground"
							>
								暂无流水记录
							</TableCell>
						</TableRow>
					) : (
						ledger.items.map((item) => (
							<LedgerRow
								key={item.id}
								item={item}
								canApplyCorrection={canApplyCorrection}
							/>
						))
					)}
				</TableBody>
			</Table>
		</div>
	);
}

/** ISO 8601 UTC 时间戳 → yyyy-MM-dd（对齐 transaction-detail.tsx 先例，直接取日期部分） */
function formatDisplayDate(isoDate: string): string {
	return isoDate.slice(0, 10);
}

function LedgerRow({
	item,
	canApplyCorrection,
}: {
	item: AccountLedgerItem;
	canApplyCorrection: boolean;
}) {
	const router = useRouter();
	const badge = TYPE_BADGE[item.type];
	const isPurchase = item.type === "PURCHASE";
	const isInitial = item.type === "INITIAL";

	// 行级跳转兜底：点击已落在首个单元格内的真实 <a> 上时交给原生导航，避免重复跳转
	const onRowClick = (event: React.MouseEvent<HTMLTableRowElement>) => {
		if (!isPurchase) {
			return;
		}
		if ((event.target as HTMLElement).closest("a")) {
			return;
		}
		router.push(`/transactions/${item.id}`);
	};

	return (
		<TableRow
			className={isPurchase ? "cursor-pointer" : undefined}
			onClick={onRowClick}
		>
			<TableCell className="relative">
				<Badge variant={badge.variant}>{badge.label}</Badge>
				{isPurchase ? (
					// stretched link：真实 <a href> 覆盖首个单元格，键盘可达、语义可访问
					<Link
						href={`/transactions/${item.id}`}
						className="absolute inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					>
						<span className="sr-only">查看买入详情</span>
					</Link>
				) : null}
				{isInitial && canApplyCorrection ? (
					// 初始持仓更正入口（corrections M8 + ToB P1 能力门控）：仅具备 correction.apply 权限时展示
					<Link
						href={`/corrections/new?targetType=INITIAL_HOLDING&targetId=${item.id}`}
						className="ml-2 inline-flex items-center gap-0.5 text-xs font-medium text-mint-700 hover:underline"
						data-testid="initial-correction-entry"
					>
						<PenLine className="size-3" />
						更正
					</Link>
				) : null}
			</TableCell>
			<TableCell className="text-muted-foreground">
				{formatDisplayDate(item.occurredAt)}
			</TableCell>
			<TableCell className="font-medium text-foreground tabular-nums">
				{item.quantity}
			</TableCell>
			<TableCell>
				<span
					className={
						item.totalCost === null
							? "text-muted-foreground"
							: "font-medium text-foreground tabular-nums"
					}
				>
					{item.totalCost ?? "—"}
				</span>
				{!item.feeKnown ? (
					<Badge
						variant="outline"
						className="ml-2 border-cream-300 bg-cream-100 text-ink-600"
					>
						费用未明确
					</Badge>
				) : null}
			</TableCell>
		</TableRow>
	);
}
