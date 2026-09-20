import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsIn, IsOptional, IsString } from "class-validator";
import { PACE_PREFERENCES, type PacePreference } from "../schedule-builder";

/**
 * 换汇计划模块 DTO：OpenAPI 契约唯一来源，前端类型由 generate:api 产出。
 * 每个 @ApiProperty 必须显式标注 type，不得依赖转译器元数据推断。
 * 金额一律字符串传输，固定 4 位小数（Decimal(20, 4)）；
 * 日期一律 ISO 8601 UTC（00:00:00.000Z）。
 * 值域校验（币种 ∈ 15 币种、prepLeadDays 1~30、节奏枚举、金额上限等）
 * 统一在 PlanService 以 { code, message } 400 抛出，保持错误契约一致。
 */

/** POST /api/plans/schedule-preview 请求体 */
export class SchedulePreviewDto {
	@ApiProperty({
		description: "目标币种（ISO 4217，必须在支持的 15 币种内）",
		example: "USD",
		type: String,
	})
	@IsString({ message: "目标币种必须是字符串" })
	targetCurrency!: string;

	@ApiProperty({
		description: "目标金额（正数字符串，≤ 单笔上限 100,000,000,000）",
		example: "50000.00",
		type: String,
	})
	@IsString({ message: "目标金额必须是字符串" })
	targetAmount!: string;

	@ApiProperty({
		description: "期望用汇日（ISO 8601，必须晚于今天）",
		example: "2027-08-01T00:00:00.000Z",
		type: String,
	})
	@IsString({ message: "用途日期必须是字符串" })
	expectUseDate!: string;

	@ApiProperty({
		description: "提前准备天数（1~30 整数）",
		example: 3,
		type: Number,
	})
	@IsInt({ message: "提前准备天数必须是整数" })
	prepLeadDays!: number;

	@ApiProperty({
		description:
			"资金准备节奏（conservative=安心 / balanced=均衡 / aggressive=主动）",
		example: "balanced",
		type: String,
	})
	@IsString({ message: "资金准备节奏必须是字符串" })
	pacePreference!: string;

	@ApiProperty({
		description:
			"开始准备日（ISO 8601；缺省 = 最早可安排日，即明天起首个工作日）",
		example: null,
		type: String,
		nullable: true,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "开始准备日必须是字符串" })
	startDate?: string | null;
}

/** POST /api/plans 请求体：排期参数全量 + 计划名称 + 本次分配金额 */
export class CreatePlanDto extends SchedulePreviewDto {
	@ApiProperty({
		description: "目标名称（缺省存 null）",
		example: "今年换 5 万美元",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "目标名称必须是字符串" })
	name?: string;

	@ApiProperty({
		description:
			'本次计入已有外币的分配金额（≥ 0，≤ 可分配余额与目标金额较小者；缺省 "0" 不占用余额）',
		example: "12000.00",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "分配金额必须是字符串" })
	allocatedAmount?: string;
}

/** 单条分批排期（preview 与 PlanDto 共用） */
export class PlanInstallmentDto {
	@ApiProperty({ description: "批次序号（1 起）", example: 1, type: Number })
	seq!: number;

	@ApiProperty({
		description: "该批准备日期（ISO 8601 UTC 0 点）",
		example: "2027-07-28T00:00:00.000Z",
		type: String,
	})
	scheduledAt!: string;

	@ApiProperty({
		description: "该批金额（按币种精度向下取整，固定 4 位小数字符串）",
		example: "16666.6600",
		type: String,
	})
	amount!: string;
}

/** 可分配余额信息（供前端对「计入已有外币」做实时校验） */
export class AllocatableCapsDto {
	@ApiProperty({
		description:
			"该币种可分配余额 = 账户余额 − 其他计划剩余分配之和（固定 4 位小数字符串）",
		example: "12000.0000",
		type: String,
	})
	allocatableBalance!: string;

	@ApiProperty({
		description:
			"本次分配上限 = min(可分配余额, 目标金额)（固定 4 位小数字符串）",
		example: "12000.0000",
		type: String,
	})
	maxAllocatable!: string;
}

/** POST /api/plans/schedule-preview 响应 data */
export class SchedulePreviewResultDto {
	@ApiProperty({
		description: "最晚准备日（服务端按用途日期与提前天数重算）",
		example: "2027-07-28T00:00:00.000Z",
		type: String,
	})
	latestPrepDate!: string;

	@ApiProperty({
		description: "分批排期（3/2/1 批，日期升序）",
		type: [PlanInstallmentDto],
	})
	installments!: PlanInstallmentDto[];

	@ApiProperty({
		description: "该币种可分配余额信息",
		type: AllocatableCapsDto,
	})
	caps!: AllocatableCapsDto;
}

/** POST /api/plans 响应 data */
export class PlanDto {
	@ApiProperty({
		description: "计划 ID（cuid）",
		example: "cmex5g2h70000abcd",
		type: String,
	})
	id!: string;

	@ApiProperty({
		description: "目标名称（缺省为 null）",
		example: "今年换 5 万美元",
		type: String,
		nullable: true,
	})
	name!: string | null;

	@ApiProperty({
		description: "目标币种（ISO 4217）",
		example: "USD",
		type: String,
	})
	targetCurrency!: string;

	@ApiProperty({
		description: "目标金额（固定 4 位小数字符串）",
		example: "50000.0000",
		type: String,
	})
	targetAmount!: string;

	@ApiProperty({
		description: "已分配金额（固定 4 位小数字符串）",
		example: "12000.0000",
		type: String,
	})
	allocatedAmount!: string;

	@ApiProperty({
		description: "剩余分配 = amount − usedAmount（创建时 usedAmount = 0）",
		example: "12000.0000",
		type: String,
	})
	remainingAmount!: string;

	@ApiProperty({
		description: "期望用汇日（ISO 8601 UTC）",
		example: "2027-08-01T00:00:00.000Z",
		type: String,
	})
	expectUseDate!: string;

	@ApiProperty({
		description: "最晚准备日（服务端重算，不信任前端）",
		example: "2027-07-28T00:00:00.000Z",
		type: String,
	})
	latestPrepDate!: string;

	@ApiProperty({
		description: "提前准备天数（1~30）",
		example: 3,
		type: Number,
	})
	prepLeadDays!: number;

	@ApiProperty({
		description: "资金准备节奏",
		example: "balanced",
		enum: [...PACE_PREFERENCES],
	})
	pacePreference!: PacePreference;

	@ApiProperty({
		description: "计划状态",
		example: "ACTIVE",
		enum: ["ACTIVE", "COMPLETED", "CANCELLED"],
	})
	status!: "ACTIVE" | "COMPLETED" | "CANCELLED";

	@ApiProperty({
		description: "分批排期（3/2/1 批）",
		type: [PlanInstallmentDto],
	})
	installments!: PlanInstallmentDto[];
}

// ────────────────────────── M5 计划管理（plan-management §4.1~4.6）──────────────────────────

/** GET /api/plans?status= 查询参数 */
export class PlanListQueryDto {
	@ApiProperty({
		description: "按计划状态过滤（缺省返回全部）",
		example: "ACTIVE",
		enum: ["ACTIVE", "COMPLETED", "CANCELLED"],
		required: false,
	})
	@IsOptional()
	@IsIn(["ACTIVE", "COMPLETED", "CANCELLED"], {
		message: "状态必须是 ACTIVE / COMPLETED / CANCELLED 之一",
	})
	status?: string;
}

/** 计划列表项（GET /api/plans 出参，plan-management §4.1） */
export class PlanListItemDto {
	@ApiProperty({
		description: "计划 ID（cuid）",
		example: "cmex5g2h70000abcd",
		type: String,
	})
	id!: string;

	@ApiProperty({
		description: "目标名称（缺省为 null）",
		example: "今年换 5 万美元",
		type: String,
		nullable: true,
	})
	name!: string | null;

	@ApiProperty({
		description: "计划状态",
		example: "ACTIVE",
		enum: ["ACTIVE", "COMPLETED", "CANCELLED"],
	})
	status!: "ACTIVE" | "COMPLETED" | "CANCELLED";

	@ApiProperty({
		description: "目标币种（ISO 4217）",
		example: "USD",
		type: String,
	})
	targetCurrency!: string;

	@ApiProperty({
		description: "目标金额（固定 4 位小数字符串）",
		example: "50000.0000",
		type: String,
	})
	targetAmount!: string;

	@ApiProperty({
		description: "累计已使用（M7 写入；当前恒 0.0000；固定 4 位小数字符串）",
		example: "4000.0000",
		type: String,
	})
	usedAmount!: string;

	@ApiProperty({
		description: "分配总额（留给该计划的金额，固定 4 位小数字符串）",
		example: "6000.0000",
		type: String,
	})
	allocatedAmount!: string;

	@ApiProperty({
		description:
			"计划剩余分配 = max(0, 分配总额 − 累计已使用)（固定 4 位小数字符串）",
		example: "2000.0000",
		type: String,
	})
	remainingAllocation!: string;

	@ApiProperty({
		description:
			"资金缺口 = max(0, 还需使用金额 − 计划剩余分配)；0 即钱已备齐（固定 4 位小数字符串）",
		example: "8000.0000",
		type: String,
	})
	gap!: string;

	@ApiProperty({
		description: "最晚准备日期（ISO 8601 UTC）",
		example: "2027-07-28T00:00:00.000Z",
		type: String,
	})
	latestPrepDate!: string;

	@ApiProperty({
		description:
			"下一准备节点日期（未到期的最早准备节点；无排期或已全部过期为 null，ISO 8601 UTC）",
		example: "2027-07-01T00:00:00.000Z",
		type: String,
		nullable: true,
	})
	nextInstallmentAt!: string | null;

	@ApiProperty({
		description:
			"最近更新时间（ISO 8601，乐观锁 expectedUpdatedAt 取自本字段）",
		example: "2026-09-16T08:30:00.123Z",
		type: String,
	})
	updatedAt!: string;
}

/** 修改记录（plan_change_logs 行；GET /api/plans/:id 的 changeLogs 元素） */
export class PlanChangeLogDto {
	@ApiProperty({ description: "记录 ID", type: String })
	id!: string;

	@ApiProperty({
		description:
			"变更主类型：TARGET_ADJUSTED / ALLOCATION_ADJUSTED / PARAMS_ADJUSTED（节奏·缓冲·开始日）/ COMPLETED / CANCELLED / REOPENED",
		example: "TARGET_ADJUSTED",
		type: String,
	})
	changeType!: string;

	@ApiProperty({
		description: "变更前目标金额（固定 4 位小数字符串）",
		example: "10000.0000",
		type: String,
	})
	beforeTarget!: string;

	@ApiProperty({
		description: "变更后目标金额（固定 4 位小数字符串）",
		example: "8000.0000",
		type: String,
	})
	afterTarget!: string;

	@ApiProperty({
		description: "变更前分配总额（固定 4 位小数字符串）",
		example: "6000.0000",
		type: String,
	})
	beforeAlloc!: string;

	@ApiProperty({
		description: "变更后分配总额（固定 4 位小数字符串）",
		example: "4000.0000",
		type: String,
	})
	afterAlloc!: string;

	@ApiProperty({
		description: "本次释放的分配额（回到未分配余额，固定 4 位小数字符串）",
		example: "2000.0000",
		type: String,
	})
	releasedAmount!: string;

	@ApiProperty({
		description:
			"变更前全量快照（含目标/分配/已使用/剩余/缺口/节奏/准备缓冲/开始日/状态等，金额 4 位小数字符串、日期 ISO 8601）",
		type: Object,
	})
	beforeSnapshot!: Record<string, unknown>;

	@ApiProperty({
		description: "变更后全量快照（结构同 beforeSnapshot）",
		type: Object,
	})
	afterSnapshot!: Record<string, unknown>;

	@ApiProperty({
		description: "变更时间（ISO 8601）",
		example: "2026-09-16T08:30:00.123Z",
		type: String,
	})
	createdAt!: string;
}

/** 计划详情（GET /api/plans/:id、PATCH /plans/:id、complete / cancel 出参，§4.2） */
export class PlanDetailDto extends PlanListItemDto {
	@ApiProperty({
		description:
			"资金准备节奏（conservative=安心 / balanced=均衡 / aggressive=主动）",
		example: "balanced",
		enum: [...PACE_PREFERENCES],
	})
	pacePreference!: PacePreference;

	@ApiProperty({
		description: "准备缓冲（提前准备的工作日天数，1~30）",
		example: 3,
		type: Number,
	})
	prepLeadDays!: number;

	@ApiProperty({
		description: "预计使用日期（ISO 8601 UTC，不可修改）",
		example: "2027-08-01T00:00:00.000Z",
		type: String,
	})
	expectUseDate!: string;

	@ApiProperty({
		description:
			"开始准备日（ISO 8601 UTC；重建排期 earliest 基准，未落基线为 null → 明天起首个工作日）",
		example: "2027-07-01T00:00:00.000Z",
		type: String,
		nullable: true,
	})
	planStartDate!: string | null;

	@ApiProperty({
		description: "准备节点（分批排期，按批次序号升序；已清空为空数组）",
		type: [PlanInstallmentDto],
	})
	installments!: PlanInstallmentDto[];

	@ApiProperty({
		description: "修改记录（按时间倒序；存量计划无历史为空数组）",
		type: [PlanChangeLogDto],
	})
	changeLogs!: PlanChangeLogDto[];

	@ApiProperty({
		description:
			"还需使用金额 = max(0, 目标 − 累计已使用)，最低记为 0（目标不会被系统改写，固定 4 位小数字符串）",
		example: "6000.0000",
		type: String,
	})
	stillNeeded!: string;

	@ApiProperty({
		description:
			"资金状态（服务端计算，前端只展示）：PREPARING=准备中（有缺口）/ READY=资金已备齐 / USED_UP=资金已使用完成",
		example: "READY",
		enum: ["PREPARING", "READY", "USED_UP"],
	})
	fundStatus!: "PREPARING" | "READY" | "USED_UP";

	@ApiProperty({
		description: "可否修改目标/分配/节奏/准备缓冲（仅进行中）",
		example: true,
		type: Boolean,
	})
	canModify!: boolean;

	@ApiProperty({
		description: "可否取消（仅进行中）",
		example: true,
		type: Boolean,
	})
	canCancel!: boolean;

	@ApiProperty({
		description: "可否完成确认（进行中且已使用=目标且剩余分配=0，无超用）",
		example: false,
		type: Boolean,
	})
	canComplete!: boolean;

	@ApiProperty({
		description: "可否重新开启（已完成且严格完成态：已使用=目标且剩余分配=0）",
		example: false,
		type: Boolean,
	})
	canReopen!: boolean;
}

/** POST /api/plans/:id/adjust-preview 请求体（修改预览，§4.3；「至少一项」由 service 判） */
export class AdjustPreviewDto {
	@ApiProperty({
		description:
			"新目标金额（正数字符串，≤ 单笔上限，最多 4 位小数；缺省沿用现目标）",
		example: "8000",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "目标金额必须是字符串" })
	newTargetAmount?: string;

	@ApiProperty({
		description:
			"新分配总额（≥ 0 字符串，最多 4 位小数；缺省时调低目标将自动释放多余分配）",
		example: "4000",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "分配金额必须是字符串" })
	newAllocAmount?: string;

	@ApiProperty({
		description:
			"资金准备节奏（conservative=安心 / balanced=均衡 / aggressive=主动）",
		example: "balanced",
		enum: [...PACE_PREFERENCES],
		required: false,
	})
	@IsOptional()
	@IsIn(PACE_PREFERENCES as unknown as string[], {
		message: "资金准备节奏必须是 conservative / balanced / aggressive 之一",
	})
	pacePreference?: string;

	@ApiProperty({
		description: "准备缓冲（提前准备的工作日天数，1~30 整数；缺省沿用现值）",
		example: 3,
		type: Number,
		required: false,
	})
	@IsOptional()
	@IsInt({ message: "提前准备天数必须是整数" })
	prepLeadDays?: number;

	@ApiProperty({
		description:
			"开始准备日（ISO 8601，不得早于今天；缺省 = 沿用现开始日；显式 null = 清空回退「明天起首个工作日」）",
		example: "2027-07-01T00:00:00.000Z",
		type: String,
		nullable: true,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "开始准备日必须是字符串" })
	startDate?: string | null;
}

/** PATCH /api/plans/:id 请求体（提交修改 / 重新开启，§4.4） */
export class AdjustPlanDto extends AdjustPreviewDto {
	@ApiProperty({
		description:
			"乐观锁：取自计划详情 updatedAt 原值；不匹配返回 409 PLAN_STATE_CHANGED",
		example: "2026-09-16T08:30:00.123Z",
		type: String,
	})
	@IsString({ message: "expectedUpdatedAt 必须是字符串" })
	expectedUpdatedAt!: string;

	@ApiProperty({
		description:
			"重新开启确认：已完成计划提高目标时必须为 true；进行中计划携带会被忽略；重开时不得同时携带分配/节奏/准备缓冲参数",
		example: true,
		type: Boolean,
		required: false,
	})
	@IsOptional()
	@IsBoolean({ message: "confirmReopen 必须是布尔值" })
	confirmReopen?: boolean;
}

/** 修改预览 caps 三值（PLAN_ALLOCATION_LIMIT 错误 data.caps 同构） */
export class AdjustCapsDto {
	@ApiProperty({
		description:
			"修改分配总额上限 = min(还需使用金额, 未分配余额 + 本计划原分配总额)（固定 4 位小数字符串）",
		example: "7000.0000",
		type: String,
	})
	limit!: string;

	@ApiProperty({
		description:
			"未分配余额 = 账户余额 − Σ同币种各计划剩余分配（固定 4 位小数字符串）",
		example: "5000.0000",
		type: String,
	})
	unallocatedBalance!: string;

	@ApiProperty({
		description:
			"还需使用金额 = max(0, 新目标 − 累计已使用)（固定 4 位小数字符串）",
		example: "10000.0000",
		type: String,
	})
	stillNeeded!: string;
}

/** 修改前/后状态快照（§4.3 before / after） */
export class PlanAdjustSnapshotDto {
	@ApiProperty({
		description: "目标金额（固定 4 位小数字符串）",
		example: "10000.0000",
		type: String,
	})
	targetAmount!: string;

	@ApiProperty({
		description: "分配总额（固定 4 位小数字符串）",
		example: "6000.0000",
		type: String,
	})
	allocAmount!: string;

	@ApiProperty({
		description: "累计已使用（固定 4 位小数字符串）",
		example: "0.0000",
		type: String,
	})
	usedAmount!: string;

	@ApiProperty({
		description: "计划剩余分配（固定 4 位小数字符串）",
		example: "6000.0000",
		type: String,
	})
	remainingAllocation!: string;

	@ApiProperty({
		description: "资金缺口（固定 4 位小数字符串）",
		example: "4000.0000",
		type: String,
	})
	gap!: string;

	@ApiProperty({
		description: "资金准备节奏",
		example: "balanced",
		enum: [...PACE_PREFERENCES],
	})
	pacePreference!: string;

	@ApiProperty({
		description: "准备缓冲（工作日天数）",
		example: 3,
		type: Number,
	})
	prepLeadDays!: number;

	@ApiProperty({
		description: "开始准备日（ISO 8601；未落基线为 null）",
		example: "2027-07-01T00:00:00.000Z",
		type: String,
		nullable: true,
	})
	planStartDate!: string | null;
}

/** 修改影响（§4.3 impact） */
export class AdjustImpactDto {
	@ApiProperty({
		description: "本次释放的分配额（回到未分配余额，固定 4 位小数字符串）",
		example: "2000.0000",
		type: String,
	})
	releasedAmount!: string;

	@ApiProperty({
		description: "新资金缺口（固定 4 位小数字符串）",
		example: "4000.0000",
		type: String,
	})
	newGap!: string;

	@ApiProperty({
		description: "新排期（准备节点；缺口为 0 时为 null——现有排期将被清空）",
		type: [PlanInstallmentDto],
		nullable: true,
	})
	newSchedule!: PlanInstallmentDto[] | null;

	@ApiProperty({
		description: "现有排期是否将被清空（newSchedule 为 null 时恒 true）",
		example: false,
		type: Boolean,
	})
	scheduleDropped!: boolean;
}

/** POST /api/plans/:id/adjust-preview 响应 data（只读预览，不落库） */
export class AdjustPreviewResultDto {
	@ApiProperty({
		description: "本次调整是否可行（非法组合直接以 4xx 报错，不会返回 false）",
		example: true,
		type: Boolean,
	})
	valid!: boolean;

	@ApiProperty({
		description:
			"是否为重新开启（已完成计划提高目标场景；true 时提交须带 confirmReopen: true）",
		example: false,
		type: Boolean,
	})
	reopen!: boolean;

	@ApiProperty({
		description: "caps 三值（重新开启场景省略）",
		type: AdjustCapsDto,
		required: false,
		nullable: true,
	})
	caps?: AdjustCapsDto | null;

	@ApiProperty({ description: "修改影响", type: AdjustImpactDto })
	impact!: AdjustImpactDto;

	@ApiProperty({ description: "修改前状态快照", type: PlanAdjustSnapshotDto })
	before!: PlanAdjustSnapshotDto;

	@ApiProperty({ description: "修改后状态快照", type: PlanAdjustSnapshotDto })
	after!: PlanAdjustSnapshotDto;

	@ApiProperty({
		description: "新最晚准备日期（按用途日期与准备缓冲重算，ISO 8601 UTC）",
		example: "2027-07-28T00:00:00.000Z",
		type: String,
	})
	newLatestPrepDate!: string;
}

/** 模块错误响应体（统一 { code, message }，风格与 onboarding/rate 模块一致；data 按错误码可选携带） */
export class PlanErrorDto {
	@ApiProperty({
		description:
			"错误码：INVALID_PLAN_PARAMS / NO_AVAILABLE_DATES / AMOUNT_TOO_SMALL / INSUFFICIENT_ALLOCATABLE_BALANCE / PLAN_NOT_FOUND / PLAN_STATE_CHANGED / PLAN_INVALID_TRANSITION / PLAN_TARGET_BELOW_USED / PLAN_ALLOCATION_LIMIT / PLAN_ALLOCATION_BELOW_USED / PLAN_COMPLETE_NOT_READY",
		example: "INSUFFICIENT_ALLOCATABLE_BALANCE",
		type: String,
	})
	code!: string;

	@ApiProperty({
		description: "错误描述",
		example: "可分配余额不足，请调整分配金额",
		type: String,
	})
	message!: string;
}
