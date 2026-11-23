import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * 授权层统一错误族（技术方案 §4.3 / §7.1；Goal #3A W17）。
 *
 * 语义约定：
 * - 400 ORGANIZATION_REQUIRED：组织上下文缺失/格式非法（含非字符串数组头）；
 * - 404 ORGANIZATION_NOT_FOUND：非成员/已禁用/组织不存在统一 404，
 *   **禁止返回 403 泄露组织存在性**（§7.1）；
 * - 403 PERMISSION_DENIED：有效成员但角色无对应权限点。
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
