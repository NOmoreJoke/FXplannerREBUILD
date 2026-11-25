import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * 授权层统一错误族（技术方案 §4.3 / §7.1；Goal #3A W17）。
 *
 * 语义约定：
 * - 400 ORGANIZATION_REQUIRED：组织上下文缺失/格式非法（含非字符串数组头）；
 * - 404 ORGANIZATION_NOT_FOUND：非成员/已禁用/组织不存在统一 404，
 *   **禁止返回 403 泄露组织存在性**（§7.1）；
 * - 403 PERMISSION_DENIED：有效成员但角色无对应权限点；
 * - 403 ORGANIZATION_DATA_LOCKED：**当前组织**账本清空 / 删除处理中
 *   （与个人账号锁 ACCOUNT_PENDING_DELETION 严格区分，§7.1）。
 * 响应体统一 { success: false, code, message }（与既有 DataRequest 错误族同形）。
 */

export class OrganizationRequiredException extends HttpException {
	constructor(
		message = "缺少组织上下文（X-Organization-Id）",
		code = "ORGANIZATION_REQUIRED",
	) {
		super({ success: false, code, message }, HttpStatus.BAD_REQUEST);
	}
}

export class OrganizationNotFoundException extends HttpException {
	constructor(
		message = "组织不存在或无权访问",
		code = "ORGANIZATION_NOT_FOUND",
	) {
		super({ success: false, code, message }, HttpStatus.NOT_FOUND);
	}
}

export class PermissionDeniedException extends HttpException {
	constructor(
		message = "当前角色无权执行该操作",
		code = "PERMISSION_DENIED",
	) {
		super({ success: false, code, message }, HttpStatus.FORBIDDEN);
	}
}

/**
 * 组织数据锁拦截（技术方案 §9.3；Goal #3B W27）。
 *
 * 与个人账号锁（ACCOUNT_PENDING_DELETION）严格区分：前者锁**当前组织**的账本
 * （清空 / 删除处理中），后者锁**本人账号**（注销处理中）。两者互不误判、
 * 互不触发对方的跳转语义。
 */
export class OrganizationDataLockedException extends HttpException {
	constructor(subject?: { type?: string } | null) {
		super(
			{
				success: false,
				code: "ORGANIZATION_DATA_LOCKED",
				message:
					subject?.type === "DELETION"
						? "组织删除处理中，业务操作暂不可用"
						: "清空业务记录处理中，业务操作暂不可用",
			},
			HttpStatus.FORBIDDEN,
		);
	}
}

/**
 * 个人账号锁拦截（技术方案 §7.1 / §9.3；Goal #3B W27）。
 *
 * 只锁**本人**（账号注销处理中），绝不锁同组织的其他成员；与
 * OrganizationDataLockedException（锁当前组织账本）严格区分。
 */
export class AccountPendingDeletionException extends HttpException {
	constructor(
		message = "账号注销处理中，仅可查看数据请求进度",
		code = "ACCOUNT_PENDING_DELETION",
	) {
		super({ success: false, code, message }, HttpStatus.FORBIDDEN);
	}
}
