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
	DisplayStatus,
	DataRequestType,
	OtpPurpose,
} from "../data-request-rules";

export const DATA_REQUEST_TYPES = ["EXPORT", "CLEAR", "DELETION"] as const;
/** 数据操作可用的验证用途（LOGIN 不放行数据请求，用途隔离） */
export const DATA_REQUEST_PURPOSES = ["EXPORT", "CLEAR", "DELETION"] as const;

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
			"错误码：VERIFICATION_INVALID / _EXPIRED / _USED / _PURPOSE_MISMATCH / DATA_REQUEST_NOT_FOUND / DATA_REQUEST_CONFLICT / IMPACT_CHANGED / ONBOARDING_NOT_COMPLETED / DATA_REQUEST_LOCKED / ACCOUNT_PENDING_DELETION / DOWNLOAD_EXPIRED / DATA_REQUEST_NOT_CANCELLABLE",
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

/** 锁守卫拦截（方案 §3.3） */
export class DataRequestLockedException extends HttpException {
	constructor(code: "DATA_REQUEST_LOCKED" | "ACCOUNT_PENDING_DELETION") {
		super(
			{
				success: false,
				code,
				message:
					code === "ACCOUNT_PENDING_DELETION"
						? "账号注销处理中，仅可查看数据请求进度"
						: "清空业务记录处理中，业务操作暂不可用",
			},
			HttpStatus.FORBIDDEN,
		);
	}
}
