import type {
	DataRequestPurpose,
	DataRequestScope,
	DataRequestView,
} from "@/lib/api/contract";
import type { OrganizationPermission } from "@/lib/hooks/use-organization-capabilities";

/**
 * 数据请求的展示文案与权限映射（个人域 / 组织域各一套，避免各对话框各写一份）。
 *
 * 这里只有「给人看的文字」和「按钮显隐用的权限点」，不参与授权——
 * 每个端点的真实权限判定在后端（requiredPermission + @RequiresPermission）。
 */

/** 请求类型的展示名（个人域没有 CLEAR：清空的是组织账本，不属于个人数据权利） */
export function requestTypeText(
	scope: DataRequestScope,
	type: DataRequestView["type"],
): string {
	if (scope === "PERSONAL") {
		if (type === "DELETION") return "注销个人账号";
		if (type === "CLEAR") return "个人数据请求";
		return "导出个人数据";
	}
	if (type === "CLEAR") return "清空组织账本";
	if (type === "DELETION") return "删除当前组织";
	return "导出组织账本";
}

/** 验证码用途对应的操作名（OTP 步骤说明文案） */
export function purposeText(
	scope: DataRequestScope,
	purpose: DataRequestPurpose,
): string {
	if (scope === "PERSONAL") {
		return purpose === "DELETION" ? "注销个人账号" : "导出个人数据";
	}
	if (purpose === "CLEAR") return "清空组织账本";
	if (purpose === "DELETION") return "删除当前组织";
	return "导出组织账本";
}

/**
 * 组织域请求「撤回」所需的权限点，与后端撤回时的判定同口径
 * （data-request-rules.ts requiredPermission：CLEAR → data.clear，DELETION →
 * organization.delete）。EXPORT 没有撤回窗口，返回 null。
 */
export function organizationCancelPermission(
	type: DataRequestView["type"],
): OrganizationPermission | null {
	if (type === "CLEAR") return "data.clear";
	if (type === "DELETION") return "organization.delete";
	return null;
}

/** 请求是否阻塞该数据域发起新请求：PENDING / PROCESSING / FAILED（进行中状态） */
export function isBlockingRequest(view: DataRequestView): boolean {
	return (
		view.status === "PENDING" ||
		view.status === "PROCESSING" ||
		view.status === "FAILED"
	);
}
