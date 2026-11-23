import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * 组织/成员/邀请域错误族（技术方案 §6.3/§7.2；需求 MEM-01/02、ORG-03.3）。
 * 响应体统一 { success: false, code, message }（与 authorization.errors 同形）。
 */

/** 最后 Owner 退出/移除/降权（ORG-03.3：先转移所有权或删除组织） */
export class LastOwnerRequiredException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "LAST_OWNER_REQUIRED",
				message: "组织仅剩一名所有者，须先转移所有权或删除组织",
			},
			HttpStatus.CONFLICT,
		);
	}
}

/** 成员不存在 / 非本组织成员（统一 404，防枚举） */
export class MemberNotFoundException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "MEMBER_NOT_FOUND",
				message: "成员不存在",
			},
			HttpStatus.NOT_FOUND,
		);
	}
}

/** 目标角色非法（不在五角色枚举 / 禁止操作 OWNER 位） */
export class InvalidRoleException extends HttpException {
	constructor(message: string) {
		super(
			{ success: false, code: "INVALID_ROLE", message },
			HttpStatus.BAD_REQUEST,
		);
	}
}

/** 邀请不存在或 token 无效（统一 404，防枚举；token 只存 hash） */
export class InvitationNotFoundException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "INVITATION_NOT_FOUND",
				message: "邀请不存在或已失效",
			},
			HttpStatus.NOT_FOUND,
		);
	}
}

/** 邀请状态不可接受（已用/已撤回/已拒绝/过期） */
export class InvitationNotAcceptableException extends HttpException {
	constructor(message: string) {
		super(
			{ success: false, code: "INVITATION_NOT_ACCEPTABLE", message },
			HttpStatus.CONFLICT,
		);
	}
}

/** 受邀邮箱与登录邮箱不匹配（需求 15.2.7：拒绝且不产生成员关系） */
export class InvitationEmailMismatchException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "INVITATION_EMAIL_MISMATCH",
				message: "邀请邮箱与当前登录邮箱不一致",
			},
			HttpStatus.FORBIDDEN,
		);
	}
}

/** 重复邀请但既有邀请不处于可复用态（防御性：正常路径幂等复用） */
export class InvitationConflictException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "INVITATION_CONFLICT",
				message: "存在冲突的有效邀请",
			},
			HttpStatus.CONFLICT,
		);
	}
}
