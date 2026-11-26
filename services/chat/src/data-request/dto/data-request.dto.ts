import {
	ApiProperty,
	ApiPropertyOptional,
	getSchemaPath,
} from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
	IsIn,
	IsNotEmpty,
	IsNumber,
	IsObject,
	IsOptional,
	IsString,
	ValidateNested,
} from "class-validator";
import { HttpException, HttpStatus } from "@nestjs/common";
import type {
	BlockingOrganization,
	DisplayStatus,
	DataRequestScope,
	DataRequestType,
	OtpPurpose,
} from "../data-request-rules";

export const DATA_REQUEST_TYPES = ["EXPORT", "CLEAR", "DELETION"] as const;
/** 数据域（技术方案 §9.1）：PERSONAL = 个人身份与个人数据；ORGANIZATION = 当前组织 */
export const DATA_REQUEST_SCOPES = ["PERSONAL", "ORGANIZATION"] as const;
/** 数据操作可用的验证用途（LOGIN 不放行数据请求，用途隔离） */
export const DATA_REQUEST_PURPOSES = ["EXPORT", "CLEAR", "DELETION"] as const;

/**
 * 阻塞个人注销的组织（409 LAST_OWNER_REQUIRED 的 data.blockingOrganizations 元素）：
 * 本人仍是该组织唯一所有者，须先转移所有权或删除组织。
 */
export class BlockingOrganizationDto {
	@ApiProperty({ description: "组织 ID", type: String })
	organizationId!: string;

	@ApiProperty({ description: "组织名称", type: String })
	organizationName!: string;

	@ApiProperty({
		description: "本人在该组织的成员角色（无成员关系时为 NONE）",
		example: "OWNER",
		type: String,
	})
	role!: string;
}

/** 确认页记录数量快照（CLEAR 提交时与服务端重算比对，防「验证与确认之间记录变化」） */
export class ImpactTotalsDto {
	@ApiProperty({ description: "外汇账户数", example: 2, type: Number})
	@IsNumber()
	accounts!: number;

	@ApiProperty({ description: "买入记录数", example: 3, type: Number})
	@IsNumber()
	transactions!: number;

	@ApiProperty({ description: "初始外币记录数", example: 1, type: Number})
	@IsNumber()
	initialHoldings!: number;

	@ApiProperty({ description: "换汇计划数", example: 2, type: Number})
	@IsNumber()
	plans!: number;

	@ApiProperty({ description: "资金使用记录数", example: 4, type: Number})
	@IsNumber()
	usageRecords!: number;

	@ApiProperty({ description: "更正记录数", example: 1, type: Number})
	@IsNumber()
	corrections!: number;
}

export class ImpactViewDto {
	@ApiProperty({ type: ImpactTotalsDto, description: "各业务记录数量" })
	totals!: ImpactTotalsDto;

	@ApiProperty({
		description: "是否存在可下载的导出包（确认页提示先下载）",
		example: false,
		type: Boolean })
	hasDownloadableExport!: boolean;
}

export class VerifyDataRequestDto {
	@ApiProperty({ description: "send-code 返回的挑战 ID", type: String })
	@IsString({ message: "challengeId 必须是字符串" })
	@IsNotEmpty({ message: "challengeId 不能为空" })
	challengeId!: string;

	@ApiProperty({ description: "6 位验证码", example: "123456", type: String })
	@IsString({ message: "验证码必须是 6 位数字" })
	@IsNotEmpty({ message: "验证码不能为空" })
	code!: string;

	@ApiProperty({
		description: "验证用途（LOGIN 不放行数据操作）",
		enum: DATA_REQUEST_PURPOSES,
		example: "CLEAR",
	})
	@IsIn(DATA_REQUEST_PURPOSES as unknown as string[], {
		message: "purpose 必须是 EXPORT、CLEAR 或 DELETION",
	})
	purpose!: DataRequestType;
}

export class VerifyResultDto {
	@ApiProperty({ description: "验证凭证 ID（提交请求时回传）", type: String})
	challengeId!: string;

	@ApiProperty({ enum: DATA_REQUEST_PURPOSES, description: "验证用途" })
	purpose!: OtpPurpose;

	@ApiProperty({
		description: "确认截止时刻（消费时刻 +10 分钟，ISO 8601）",
		type: String,
	})
	confirmDeadline!: Date;
}

export class CreateDataRequestDto {
	@ApiProperty({ enum: DATA_REQUEST_TYPES, description: "请求类型" })
	@IsIn(DATA_REQUEST_TYPES as unknown as string[], {
		message: "type 必须是 EXPORT、CLEAR 或 DELETION",
	})
	type!: DataRequestType;

	@ApiPropertyOptional({
		enum: DATA_REQUEST_SCOPES,
		description:
			"数据域。缺省按类型归属：CLEAR = 当前组织的 ORGANIZATION（清空的是组织账本），EXPORT / DELETION = PERSONAL。ORGANIZATION 的目标组织取 X-Organization-Id（单组织用户可缺省）；PERSONAL 仅支持 EXPORT / DELETION",
	})
	@IsOptional()
	@IsIn(DATA_REQUEST_SCOPES as unknown as string[], {
		message: "scope 必须是 PERSONAL 或 ORGANIZATION",
	})
	scope?: DataRequestScope;

	@ApiProperty({ description: "verify 返回的验证凭证 ID", type: String })
	@IsString({ message: "challengeId 必须是字符串" })
	@IsNotEmpty({ message: "challengeId 不能为空" })
	challengeId!: string;

	@ApiPropertyOptional({
		type: ImpactTotalsDto,
		description:
			"CLEAR 必带：确认页展示时的记录数量快照，与服务端重算不一致 → 409 IMPACT_CHANGED",
	})
	@IsOptional()
	@IsObject()
	@ValidateNested()
	@Type(() => ImpactTotalsDto)
	confirmedTotals?: ImpactTotalsDto;
}

export class CancelDataRequestDto {
	@ApiPropertyOptional({
		description:
			"DELETION 撤回必带：verify（purpose=DELETION）返回的挑战 ID（已消费凭证，仅登录不算撤回）；CLEAR 直接撤回无需携带",
		type: String,
	})
	@IsOptional()
	@IsString({ message: "challengeId 必须是字符串" })
	@IsNotEmpty({ message: "challengeId 不能为空" })
	challengeId?: string;
}

/**
 * 发起组织删除（DELETE /api/organizations/current）的请求体：
 * 必须携带 verify（purpose=DELETION）返回的已消费凭证——删除组织不可逆，
 * 冷静期（7 日）内仍可凭同一用途凭证撤回；仅登录不算发起。
 */
export class OrganizationDeletionRequestDto {
	@ApiProperty({
		description:
			"verify（purpose=DELETION）返回的挑战 ID（已消费凭证，仅登录不算发起删除）",
		type: String,
	})
	@IsString({ message: "challengeId 必须是字符串" })
	@IsNotEmpty({ message: "challengeId 不能为空" })
	challengeId!: string;
}

export class DataRequestDownloadDto {
	@ApiProperty({ description: "下载地址（相对 API 前缀）", example: "/api/data-requests/xxx/download", type: String })
	url!: string;

	@ApiProperty({ description: "下载失效时刻（ISO 8601）", type: String })
	expiresAt!: Date;
}

/** 请求视图（进度页/设置页统一展示模型，方案 §7.3） */
export class DataRequestViewDto {
	@ApiProperty({ description: "请求 ID", type: String })
	id!: string;

	@ApiProperty({ enum: DATA_REQUEST_TYPES, description: "请求类型" })
	type!: DataRequestType;

	@ApiProperty({
		enum: DATA_REQUEST_SCOPES,
		description: "数据域：PERSONAL（个人身份与个人数据）/ ORGANIZATION（组织账本与组织数据）",
	})
	scope!: DataRequestScope;

	@ApiPropertyOptional({
		description: "组织域请求的目标组织 ID；个人域为 null",
		type: String,
		nullable: true,
	})
	organizationId!: string | null;

	@ApiProperty({
		enum: ["PENDING", "PROCESSING", "COMPLETED", "CANCELLED", "FAILED"],
		description: "处理状态",
	})
	status!: string;

	@ApiProperty({ description: "提交时间", type: String })
	requestedAt!: Date;

	@ApiProperty({
		description: "截止时间（CLEAR 清理期限 / DELETION 撤回期截止）",
		type: String,
	})
	dueAt!: Date;

	@ApiPropertyOptional({ description: "终态时间", type: String, nullable: true })
	processedAt!: Date | null;

	@ApiProperty({
		enum: [
			"SUBMITTED",
			"WITHDRAWAL_PERIOD",
			"PROCESSING",
			"COMPLETED",
			"CANCELLED",
			"FAILED",
		],
		description: "展示状态（含注销撤回期映射）",
	})
	displayStatus!: DisplayStatus;

	@ApiProperty({ description: "是否可撤回（CLEAR PENDING / DELETION PENDING）", type: Boolean })
	canCancel!: boolean;

	@ApiPropertyOptional({
		description: "DELETION 撤回期截止（=dueAt），其余为 null",
		type: String,
		nullable: true,
	})
	withdrawDeadline!: Date | null;

	@ApiPropertyOptional({
		description: "EXPORT COMPLETED 且未过期时的下载入口，其余为 null",
		type: DataRequestDownloadDto,
		nullable: true,
	})
	download!: DataRequestDownloadDto | null;
}

// ─────────────────────────────────────────────────────────────
// 错误响应 DTO（swagger 文档标注用）
// ─────────────────────────────────────────────────────────────

export class DataRequestErrorDto {
	@ApiProperty({ description: "success 恒为 false", type: Boolean })
	success!: false;

	@ApiProperty({
		description:
			"错误码：VERIFICATION_INVALID / _EXPIRED / _USED / _PURPOSE_MISMATCH / DATA_REQUEST_NOT_FOUND / DATA_REQUEST_CONFLICT / IMPACT_CHANGED / ONBOARDING_NOT_COMPLETED / ORGANIZATION_DATA_LOCKED（当前组织账本清空/删除处理中）/ ACCOUNT_PENDING_DELETION（本人账号注销处理中）/ DOWNLOAD_EXPIRED / DATA_REQUEST_NOT_CANCELLABLE / LAST_OWNER_REQUIRED（个人注销：仍是某组织唯一所有者）/ ORGANIZATION_REQUIRED / ORGANIZATION_NOT_FOUND / PERMISSION_DENIED / SCOPE_TYPE_MISMATCH",
		type: String })
	code!: string;

	@ApiProperty({ description: "人类可读信息", type: String})
	message!: string;
}

/** 409 互斥冲突响应体（data 附原请求视图，方案 §7.8） */
export class DataRequestConflictBodyDto extends DataRequestErrorDto {
	@ApiPropertyOneOf()
	data!: unknown;
}

/** @ApiProperty 手写 oneOf（原请求视图或 null） */
function ApiPropertyOneOf() {
	return ApiProperty({
		oneOf: [{ $ref: getSchemaPath(DataRequestViewDto) }],
		// type 显式兜底：bun 转译不生成设计类型元数据，缺 type 会误触发循环依赖检测
		//（OpenAPI 文档语义以 oneOf 为准）
		type: Object,
		nullable: true,
		description: "进行中的原请求视图",
	});
}

/** 409 LAST_OWNER_REQUIRED 的 data：阻塞注销的组织列表（个人注销：须先处理阻塞组织） */
export class LastOwnerRequiredDataDto {
	@ApiProperty({
		type: [BlockingOrganizationDto],
		description: "阻塞注销的组织列表（需先转移所有权或删除这些组织）",
	})
	blockingOrganizations!: BlockingOrganizationDto[];
}

/**
 * 409 LAST_OWNER_REQUIRED 响应体（个人注销：须先处理阻塞组织）。
 * 字段位置必须与 DataRequestLastOwnerRequiredException 的运行时包体一致：列表在 data 下。
 * 此前误标在顶层，前端按契约读顶层恒取到空列表，阻塞组织与处置入口渲染不出来。
 */
export class LastOwnerRequiredBodyDto extends DataRequestErrorDto {
	@ApiProperty({
		type: LastOwnerRequiredDataDto,
		description: "最后所有者阻塞详情",
	})
	data!: LastOwnerRequiredDataDto;
}

// ─────────────────────────────────────────────────────────────
// 领域异常（统一 { success:false, code, message } 包装，对齐 OTP 锁定先例）
// ─────────────────────────────────────────────────────────────

export type VerificationErrorCode =
	| "VERIFICATION_INVALID"
	| "VERIFICATION_EXPIRED"
	| "VERIFICATION_USED"
	| "VERIFICATION_PURPOSE_MISMATCH";

const VERIFICATION_MESSAGES: Record<VerificationErrorCode, string> = {
	VERIFICATION_INVALID: "验证码无效，请重新获取",
	VERIFICATION_EXPIRED: "验证已过期，请重新验证后再提交",
	VERIFICATION_USED: "本次验证已被使用，请重新验证",
	VERIFICATION_PURPOSE_MISMATCH: "验证码用途不匹配，请获取对应用途的验证码",
};

export class DataRequestVerificationException extends HttpException {
	constructor(code: VerificationErrorCode) {
		super(
			{
				success: false,
				code,
				message: VERIFICATION_MESSAGES[code],
			},
			HttpStatus.FORBIDDEN,
		);
	}
}

export class DataRequestNotFoundException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "DATA_REQUEST_NOT_FOUND",
				message: "请求不存在",
			},
			HttpStatus.NOT_FOUND,
		);
	}
}

export class DataRequestConflictException extends HttpException {
	constructor(existingView: DataRequestViewDto) {
		super(
			{
				success: false,
				code: "DATA_REQUEST_CONFLICT",
				message: "已有进行中的数据请求，请先处理原请求",
				data: existingView,
			},
			HttpStatus.CONFLICT,
		);
	}
}

/**
 * 个人注销的最后 Owner 保护（需求 DATA-02.4 / 验收 27；技术方案 §9.2）：
 * 本人仍是若干组织的唯一所有者 → 409 并列出全部阻塞组织，不替用户选择
 * 「转移所有权」还是「删除组织」。创建阶段与到期执行的事务内复验共用。
 */
export class DataRequestLastOwnerRequiredException extends HttpException {
	constructor(blockingOrganizations: BlockingOrganization[]) {
		super(
			{
				success: false,
				code: "LAST_OWNER_REQUIRED",
				message:
					"你仍是以下组织的唯一所有者，须先转移所有权或删除组织后才能注销账号",
				data: { blockingOrganizations },
			},
			HttpStatus.CONFLICT,
		);
	}
}

export class ImpactChangedException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "IMPACT_CHANGED",
				message: "数据已发生变化，请重新确认影响后提交",
			},
			HttpStatus.CONFLICT,
		);
	}
}

/** scope × type × 组织 组合不合法（400；例如 PERSONAL + CLEAR——个人域不能清空组织账本） */
export class DataRequestScopeMismatchException extends HttpException {
	constructor(message = "数据域与请求类型不匹配：清空业务记录属于组织数据，请以当前组织提交") {
		super(
			{
				success: false,
				code: "SCOPE_TYPE_MISMATCH",
				message,
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

export class DataRequestNotCancellableException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "DATA_REQUEST_NOT_CANCELLABLE",
				message: "该请求当前不可撤回",
			},
			HttpStatus.CONFLICT,
		);
	}
}

export class DownloadExpiredException extends HttpException {
	constructor() {
		super(
			{
				success: false,
				code: "DOWNLOAD_EXPIRED",
				message: "下载链接已失效或文件已清理，可重新申请导出",
			},
			HttpStatus.GONE,
		);
	}
}

/**
 * 个人账号锁拦截（方案 §3.3；技术方案 §7.1 双锁错误码严格区分）。
 *
 * - `ACCOUNT_PENDING_DELETION`：**本人**账号注销处理中（只锁本人，绝不锁同组织他人）；
 * - 组织锁 `ORGANIZATION_DATA_LOCKED` 属授权层错误族
 *   （authorization/authorization.errors.ts 的 OrganizationDataLockedException）——
 *   守卫与契约在 authorization/（横切能力，audit 等模块亦须挂载）。
 */
export class DataRequestLockedException extends HttpException {
	constructor(code: "ACCOUNT_PENDING_DELETION") {
		super(
			{
				success: false,
				code,
				message: "账号注销处理中，仅可查看数据请求进度",
			},
			HttpStatus.FORBIDDEN,
		);
	}
}
