import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 只读 / 无权限提示（Goal #3B W28；技术方案 §6.1「前端从 capabilities 获取展示能力」）
 *
 * 当前角色缺少某个权限点时使用。两种形态共用一套视觉语言：
 * - PermissionNotice：整卡，用于页面的主体内容正依赖该权限（建账向导、新建计划、
 *   录入买入、发起更正）——不给用户一个填完表单才吃 403 的入口；
 * - PermissionHint：行内提示，用于内容本身可读、只有写操作被锁的场景（组织账本
 *   设置对 Finance / Operator / Viewer 只读）。
 *
 * 权限判定不在这里：调用方先经 useOrganizationCapabilities().can(...) 判定再渲染。
 * 后端对每个写接口强制 @RequiresPermission，这里只负责把「为什么不能操作」讲清楚。
 * 建账向导、新建计划、录入买入、发起更正、组织设置等 5 处以上复用，故进 base。
 */

/** 默认标题（各页面可在描述里说明具体是哪项操作） */
export const NO_PERMISSION_TITLE = "当前角色无权进行此操作";

export interface PermissionNoticeProps {
	/** 缺少的操作说明，如「当前角色无权创建换汇计划，请联系组织所有者或管理员」 */
	description: string;
	/** 标题；缺省用通用标题 */
	title?: string;
	/** E2E / 回归定位用的 testid，调用方按页面命名（如 plan-create-no-permission） */
	testId?: string;
	/** 补充动作（通常是返回入口的链接） */
	action?: ReactNode;
	/** 整体占满页面高度时的外边距等；缺省居中留白 */
	className?: string;
}

export function PermissionNotice({
	description,
	title = NO_PERMISSION_TITLE,
	testId,
	action,
	className,
}: PermissionNoticeProps) {
	return (
		<div
			data-testid={testId}
			className={cn(
				"mx-auto flex max-w-3xl flex-col items-center px-8 py-24 text-center",
				className,
			)}
		>
			<div className="flex size-14 items-center justify-center rounded-full bg-ink-100">
				<Lock className="size-7 text-ink-500" aria-hidden="true" />
			</div>
			<h1 className="mt-5 text-lg font-bold text-foreground">{title}</h1>
			<p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
				{description}
			</p>
			{action && <div className="mt-6">{action}</div>}
		</div>
	);
}

export interface PermissionHintProps {
	/** 只读原因，如「当前角色只能查看组织账本设置，修改需组织所有者或管理员」 */
	children: ReactNode;
	testId?: string;
	className?: string;
}

/** 行内只读提示：放在只读区块顶部，说明为什么控件不可改 */
export function PermissionHint({
	children,
	testId,
	className,
}: PermissionHintProps) {
	return (
		<p
			data-testid={testId}
			className={cn(
				"flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground",
				className,
			)}
		>
			<Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
			<span>{children}</span>
		</p>
	);
}
