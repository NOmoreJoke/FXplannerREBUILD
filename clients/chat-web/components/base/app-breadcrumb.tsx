"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

interface Crumb {
	label: string;
	/** 有 href 为可点击中间层级；末级不带 href（aria-current="page"） */
	href?: string;
}

/**
 * 解析受保护区的面包屑（唯一映射来源：新增路由在此登记即可，页面零改动）
 *
 * - 一级导航页：单级面包屑；
 * - 固定子路径：父级可点击 + 当前页；
 * - 动态段：按父路径给语义化名称（不造无列表页的假链接，transactions 无父级）；
 * - 未登记路径：兜底显示段落原名，保证任何子页面都有面包屑。
 */
export function resolveCrumbs(pathname: string): Crumb[] {
	const segments = pathname.split("/").filter(Boolean);
	if (segments.length === 0) return [];

	const [root, second] = segments;

	switch (root) {
		case "home":
			return [{ label: "首页" }];
		case "accounts":
			if (!second) return [{ label: "外汇账户" }];
			return [
				{ label: "外汇账户", href: "/accounts" },
				{ label: `${second.toUpperCase()} 账户详情` },
			];
		case "plans":
			if (!second) return [{ label: "换汇计划" }];
			if (second === "new") {
				return [{ label: "换汇计划", href: "/plans" }, { label: "新建计划" }];
			}
			return [{ label: "换汇计划", href: "/plans" }, { label: "计划详情" }];
		case "transactions":
			if (second === "new") return [{ label: "快速录入" }];
			return [{ label: "交易详情" }];
		default:
			return [{ label: decodeURIComponent(second ?? root) }];
	}
}

/**
 * 统一面包屑（base 层）：在 (protected)/layout.tsx 顶部渲染一次，
 * 所有子页面自动获得，禁止在页面内重复实现。
 *
 * actions：同一条顶栏右侧的操作区插槽（如提醒铃铛），面包屑靠左、actions 靠右；
 * 由 layout 传入（base 不反向依赖 business），页面无需感知。
 */
export function AppBreadcrumb({ actions }: { actions?: ReactNode }) {
	const pathname = usePathname();
	const crumbs = resolveCrumbs(pathname);
	if (crumbs.length === 0 && !actions) return null;

	return (
		<div className="flex items-center justify-between gap-4 border-b border-border bg-background px-8 py-3">
			<Breadcrumb aria-label="面包屑">
				<BreadcrumbList>
					{crumbs.map((crumb, index) => {
						const isLast = index === crumbs.length - 1;
						return (
							<Fragment key={`${crumb.label}-${index}`}>
								<BreadcrumbItem>
									{isLast || !crumb.href ? (
										<BreadcrumbPage>{crumb.label}</BreadcrumbPage>
									) : (
										<BreadcrumbLink asChild>
											<Link href={crumb.href}>{crumb.label}</Link>
										</BreadcrumbLink>
									)}
								</BreadcrumbItem>
								{!isLast && <BreadcrumbSeparator />}
							</Fragment>
						);
					})}
				</BreadcrumbList>
			</Breadcrumb>
			{actions && (
				<div className="flex shrink-0 items-center gap-2">{actions}</div>
			)}
		</div>
	);
}
