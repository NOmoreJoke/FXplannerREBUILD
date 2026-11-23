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

/** 并发所有权转移冲突（唯一索引兜底违规映射；最终仍恰一个活跃 Owner） */
export class TransferConflictException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "TRANSFER_CONFLICT",
				message: "所有权转移冲突（并发操作），请刷新后重试",
			},
			HttpStatus.CONFLICT,
		);
	}
}

/** 受邀邮箱已是组织有效成员（评审 I-02：禁止借邀请覆写既有成员角色） */
export class MemberAlreadyActiveException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "MEMBER_ALREADY_ACTIVE",
				message: "该邮箱已是组织有效成员，无需重复邀请",
			},
			HttpStatus.CONFLICT,
		);
	}
}

/** 目标成员已非有效状态（评审 N-06：已移除成员不可调整角色，重新邀请可恢复） */
export class MemberNotActiveException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "MEMBER_NOT_ACTIVE",
				message: "该成员已移除，不能调整角色；重新邀请可恢复",
			},
			HttpStatus.CONFLICT,
		);
	}
}

/** 成员关系已被并发修改（条件更新 0 命中；刷新后重试） */
export class MembershipConflictException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "MEMBERSHIP_CONFLICT",
				message: "成员状态已被并发修改，请刷新后重试",
			},
			HttpStatus.CONFLICT,
		);
	}
}

/** 组织名称非法（trim 后为空或超 100 字符；服务层兜底，评审 N-02） */
export class InvalidOrganizationNameException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "ORGANIZATION_NAME_INVALID",
				message: "组织名称须为 1~100 个字符",
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}
