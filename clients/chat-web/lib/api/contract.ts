/**
 * 前端契约类型薄别名层。
 *
 * 唯一来源是后端 DTO 经 OpenAPI 生成产物 schema.gen.ts（禁止手改）。
 * 本文件只做「生成名 → 业务可读名」的映射，禁止在此新写结构；
 * 后端契约变化后执行 `bun run generate:api` 重新生成，别名随之更新。
 * 若生成名与业务名一致且语义清晰，可直接从 schema.gen 导入，不必经过此层。
 */
import type { components } from "@/lib/api/schema.gen";

type Schemas = components["schemas"];

/** 当前用户公开信息（后端 UserDto，/auth/me 的 data） */
export type AuthUser = Schemas["UserDto"];

/** 登录/注册/OTP 登录接口的 data：用户 + JWT（后端 AuthResponseDto） */
export type AuthResponse = Schemas["AuthResponseDto"];

/** OTP 登录渠道（后端 SendOtpCodeDto.channel 的枚举取值） */
export type OtpChannel = Schemas["SendOtpCodeDto"]["channel"];

/** 发送验证码接口的 data：挑战 ID 与过期时间（后端 OtpChallengeResultDto） */
export type OtpChallengeResult = Schemas["OtpChallengeResultDto"];

/** 密码注册入参（后端 RegisterDto；前端确认密码由表单校验，不上送 confirmPassword） */
export type PasswordRegisterInput = Pick<
	Schemas["RegisterDto"],
	"email" | "password"
>;

/** 密码登录入参（后端 LoginDto） */
export type PasswordLoginInput = Schemas["LoginDto"];

/** 首次设置状态（后端 OnboardingStatusDto，GET /onboarding/status 的 data） */
export type OnboardingStatus = Schemas["OnboardingStatusDto"];

/** 年龄与条款确认结果（后端 OnboardingConsentsResultDto，POST /onboarding/consents 的 data） */
export type ConsentsResult = Schemas["OnboardingConsentsResultDto"];

// ---------------------------------------------------------------------------
// 首页状态：home 后端模块已落地（GET /home/state、GET /home/portfolio），
// 类型经 bun run generate:api 生成后在此别名。
// ---------------------------------------------------------------------------

/** 账户摘要（后端 AccountSummaryDto，GET /home/state 的 accounts 项） */
export type AccountSummary = Schemas["AccountSummaryDto"];

/** 换汇计划摘要（后端 PlanSummaryDto，GET /home/state 的 plans 项） */
export type PlanSummary = Schemas["PlanSummaryDto"];

// ---------------------------------------------------------------------------
// 首次设置重构（onboarding-rework）：后端 SettingsModule 与 onboarding 扩展已落地，
// 类型经 bun run generate:api 生成后在此别名。
// ---------------------------------------------------------------------------

/** 初始持仓入参项（POST /onboarding/complete 与 POST /onboarding/initial-holdings 共用；金额字符串） */
export type InitialHoldingItem = Schemas["InitialHoldingItemDto"];

/** 补录初始持仓出参（POST /onboarding/initial-holdings 的 data；created 元素含 rawRate/来源/报价时间/成本） */
export type InitialHoldingsResult = Schemas["InitialHoldingsResultDto"];

/** 完成建账入参（POST /onboarding/complete；偏好与初始持仓均可选，缺省由服务端兜底） */
export type CompleteOnboardingReq = Schemas["CompleteOnboardingDto"];

/** 用户设置视图（GET/PATCH /settings 的 data；本位币只读，无更新通道） */
export type SettingsView = Schemas["SettingsViewDto"];

/** 更新设置入参（PATCH /settings；全可选至少一项，DTO 不含 baseCurrency——白名单拒绝） */
export type UpdateSettingsReq = Schemas["UpdateSettingsDto"];

/** 设置模块错误码（400 SETTINGS_UPDATE_EMPTY 等） */
export type SettingsErrorCode = Schemas["SettingsErrorDto"]["code"];

/** 首页状态（后端 HomeStateDto，GET /home/state 的 data）：分流布尔 + hasInitialHoldings + 账户/计划摘要 */
export type HomeState = Schemas["HomeStateDto"];

// ---------------------------------------------------------------------------
// 买入交易（transaction-entry）：后端 TransactionModule 已落地，
// 类型由 bun run generate:api 生成后经此层别名（不再临时手写）。
// ---------------------------------------------------------------------------

/** 创建买入请求（POST /transactions；两种填法三值同送，后端做双向自洽校验） */
export type CreateTransactionReq = Schemas["CreateTransactionDto"];

/** 交易详情（创建与 GET /transactions/:id 共用；金额固定 4 位、汇率固定 8 位小数字符串） */
export type TransactionDto = Schemas["TransactionDto"];

/** 交易模块错误码（400/404 响应体的 code 枚举，前端据此分支提示） */
export type TransactionErrorCode = Schemas["TransactionErrorDto"]["code"];

// ---------------------------------------------------------------------------
// 创建换汇计划（临时手写）：plan 后端模块生成链路（bun run generate:api）尚未覆盖，
// 按 changes/plan-creation/技术方案.md §5 契约补齐；后端落地后重新生成并替换为
// schema.gen 别名（与 HomeState 同一路径）。
// ---------------------------------------------------------------------------

/** 资金准备节奏（后端 pacePreference 枚举：安心/均衡/主动） */
export type PacePreference = "conservative" | "balanced" | "aggressive";

/** 排期预览请求（POST /plans/schedule-preview；startDate/allocatedAmount 缺省见后端 DTO） */
export type PlanSchedulePreviewReq = {
	/** 目标币种（15 币种清单内） */
	targetCurrency: string;
	/** 净到账金额（金额字符串，Decimal(20,4)） */
	targetAmount: string;
	/** 期望用汇日，ISO 8601 UTC */
	expectUseDate: string;
	/** 提前准备天数（1~30） */
	prepLeadDays: number;
	/** 资金准备节奏 */
	pacePreference: PacePreference;
	/** 开始准备日，ISO 8601 UTC；null/缺省 = 最早可安排日 */
	startDate?: string | null;
	/** 计入已有外币（金额字符串；缺省 "0"；预览排期按 目标 − 该值 计算，与创建口径一致） */
	allocatedAmount?: string;
};

/** 分批排期中的一批（后端 PlanInstallment） */
export type PlanInstallment = {
	/** 批次序号（1..3） */
	seq: number;
	/** 该批准备日期，ISO 8601 UTC */
	scheduledAt: string;
	/** 该批金额（金额字符串，Decimal(20,4)） */
	amount: string;
};

/** 可分配余额上限（预览随响应返回，供前端对「计入已有外币」做实时预检） */
export type PlanCaps = {
	/** 该币种可分配余额（金额字符串） */
	allocatableBalance: string;
	/** 本次分配上限 = min(可分配余额, 目标金额)（金额字符串） */
	maxAllocatable: string;
};

/** 排期预览响应（POST /plans/schedule-preview 的 data；只读不落库） */
export type PlanSchedulePreviewResp = {
	/** 最晚准备日，ISO 8601 UTC */
	latestPrepDate: string;
	/** 3 条分批排期 */
	installments: PlanInstallment[];
	/** 可分配余额上限 */
	caps: PlanCaps;
};

/** 创建计划请求（POST /plans）= 预览请求全字段（含 allocatedAmount）+ name */
export type CreatePlanReq = PlanSchedulePreviewReq & {
	/** 目标名称（可空；缺省时后端落 null） */
	name?: string;
};

// ---------------------------------------------------------------------------
// 计划管理（plan-management M5）：后端 PlanModule 已落地，
// 类型由 bun run generate:api 生成后经此层别名。
// ---------------------------------------------------------------------------

/** 计划状态（三值枚举，与后端一致） */
export type PlanStatus = Schemas["PlanListItemDto"]["status"];

/** 计划列表项（GET /plans 出参 items 元素；金额 4 位小数字符串，updatedAt 倒序） */
export type PlanListItem = Schemas["PlanListItemDto"];

/** 计划列表响应 data（GET /plans 的 data：{ items }） */
export type PlanListResp = { items: PlanListItem[] };

/** 计划列表状态筛选值（GET /plans?status=；缺省全部） */
export type PlanListStatus = Schemas["PlanListQueryDto"]["status"];

/** 计划详情（GET /plans/:id、PATCH /plans/:id、complete/cancel 出参；含 canXxx 操作标记） */
export type PlanDetail = Schemas["PlanDetailDto"];

/** 修改记录（plan_change_logs 行；PlanDetail.changeLogs 元素，时间倒序） */
export type PlanChangeLog = Schemas["PlanChangeLogDto"];

/** 修改预览/提交参数（至少一项；金额字符串、节奏枚举、天数整数） */
export type AdjustPlanParams = Schemas["AdjustPreviewDto"];

/** 修改提交参数（= 预览参数 + 乐观锁 expectedUpdatedAt + confirmReopen） */
export type AdjustPlanReq = Schemas["AdjustPlanDto"];

/** 修改预览结果（POST /plans/:id/adjust-preview 的 data，只读不落库） */
export type AdjustPreviewResult = Schemas["AdjustPreviewResultDto"];

/** 修改分配总额上限三值（PLAN_ALLOCATION_LIMIT 错误 data.caps 同构，超限预填数据源） */
export type AdjustCaps = Schemas["AdjustCapsDto"];

/** 计划模块错误码（400/404/409 响应体的 code 枚举，前端据此分支提示） */
export type PlanErrorCode = Schemas["PlanErrorDto"]["code"];

// ---------------------------------------------------------------------------
// 资金使用（usage-recording M7）：后端 UsageModule 已落地，
// 类型经 bun run generate:api 生成后在此别名。
// ---------------------------------------------------------------------------

/** 记录使用入参（POST /plans/:id/usages；金额字符串、日期 ISO、备注可选） */
export type CreateUsageReq = Schemas["CreateUsageDto"];

/** 单条使用记录（含本笔 FIFO 使用成本与 version，M8 更正预留恒 1） */
export type UsageRecord = Schemas["UsageDto"];

/** 使用记录列表响应（GET /plans/:id/usages 的 data：{ items }） */
export type UsageListResp = Schemas["UsageListRespDto"];

/** 计划资金面快照（记录使用成功后返回，含 fundStatus/canComplete） */
export type PlanFundSummary = Schemas["PlanFundSummaryDto"];

/** 资金状态（服务端计算：准备中/资金已备齐/资金已使用完成） */
export type FundStatus = Schemas["PlanFundSummaryDto"]["fundStatus"];

/** 计划详情（后端 PlanDto，POST /plans 的 data） */
export type PlanDto = {
	/** 计划 ID（cuid） */
	id: string;
	/** 目标名称（可空） */
	name: string | null;
	/** 目标币种 */
	targetCurrency: string;
	/** 目标金额（金额字符串） */
	targetAmount: string;
	/** 已分配金额（金额字符串） */
	allocatedAmount: string;
	/** 剩余可分配 = allocatedAmount − usedAmount（服务端计算） */
	remainingAmount: string;
	/** 期望用汇日，ISO 8601 UTC */
	expectUseDate: string;
	/** 最晚备汇日（服务端重算，不信任前端），ISO 8601 UTC */
	latestPrepDate: string;
	/** 提前准备天数 */
	prepLeadDays: number;
	/** 资金准备节奏 */
	pacePreference: PacePreference;
	/** 计划状态（新建即为进行中） */
	status: "ACTIVE";
	/** 3 条分批排期 */
	installments: PlanInstallment[];
};

// ---------------------------------------------------------------------------
// 站内提醒（reminders）：后端 ReminderModule 已落地（GET /reminders、
// POST /reminders/:id/read、POST /reminders/read-all），
// 类型经 bun run generate:api 生成后在此别名。
// ---------------------------------------------------------------------------

/** 提醒列表视图（后端 RemindersViewDto，GET /reminders 的 data；入口内置读时懒生成） */
export type RemindersView = Schemas["RemindersViewDto"];

/** 提醒列表项（后端 ReminderItemDto；matters 为读时派生的事项数组） */
export type ReminderItem = Schemas["ReminderItemDto"];

/** 提醒事项（后端 ReminderMatterDto；同计划同日合并后可并列多条） */
export type ReminderMatter = Schemas["ReminderMatterDto"];

/** 单条已读结果（后端 ReminderReadResultDto，幂等返回既有 readAt） */
export type ReminderReadResult = Schemas["ReminderReadResultDto"];

/** 全部已读结果（后端 ReminderReadAllResultDto） */
export type ReminderReadAllResult = Schemas["ReminderReadAllResultDto"];

// ---------------------------------------------------------------------------
// 成本摘要与报告（reports M10）：后端 ReportModule 已落地，
// 类型经 bun run generate:api 生成后在此别名（reports 技术方案 §5/§6）。
// ---------------------------------------------------------------------------

/** 报告中心列表项（GET /reports/plans 出参 items 元素；金额 4 位字符串、均价 8 位字符串） */
export type ReportPlanListItem = Schemas["ReportPlanListItemDto"];

/** 报告中心列表响应 data（GET /reports/plans 的 data：baseCurrency + items） */
export type ReportPlanList = Schemas["ReportPlanListDto"];

/** 报告列表状态筛选值（GET /reports/plans?status=；缺省全部） */
export type ReportListStatus = Schemas["ReportPlanListItemDto"]["status"];

/** 单计划报告（GET /reports/plans/:id 的 data；页面摘要与打印视图共用数据源） */
export type PlanReport = Schemas["PlanReportDto"];

/** 报告模块错误码（400 INVALID_REPORT_PARAMS / 404 PLAN_NOT_FOUND） */
export type ReportErrorCode = Schemas["ReportErrorDto"]["code"];

// ---------------------------------------------------------------------------
// 更正与日志（corrections M8）：后端 CorrectionModule 已落地，
// 类型经 bun run generate:api 生成后在此别名（corrections 技术方案 §6）。
// ---------------------------------------------------------------------------

/** 更正目标类型（TRANSACTION / USAGE / INITIAL_HOLDING；USAGE 自 MVP-F0-3 起支持改金额与改日期） */
export type CorrectionTargetType =
	Schemas["CorrectionRequestDto"]["targetType"];

/** 影响预览 / 提交更正请求体（同构；apply 透传 baseVersion/baseUpdatedAt 做乐观校验） */
export type CorrectionRequest = Schemas["CorrectionRequestDto"];

/** 拟变更集合（缺省字段 = 不修改；feeAmount 显式 null = 改回「未知」） */
export type CorrectionChanges = Schemas["CorrectionChangesDto"];

/** 影响预览结果（前后对比 + 余额/分配/成本影响 + blockers 拦截明细） */
export type CorrectionPreview = Schemas["CorrectionPreviewDto"];

/** 提交更正结果（correctionId + 目标新版本号） */
export type CorrectionApplyResult = Schemas["CorrectionApplyResultDto"];

/** 修改记录条目（含 APPLIED 与 FAILED；FAILED 附 failReason） */
export type CorrectionLogItem = Schemas["CorrectionDto"];

/** 修改记录列表（createdAt 倒序分页） */
export type CorrectionLogList = Schemas["CorrectionListDto"];

/** 更正目标当前内容（更正页表单初值与乐观校验基准） */
export type CorrectionTarget = Schemas["CorrectionTargetDto"];

/** 更正模块错误码（400/404/409 响应体的 code 枚举） */
export type CorrectionErrorCode = Schemas["CorrectionErrorDto"]["code"];

/** 拦截项（blockers 元素；非空 = 不能提交） */
export type CorrectionBlocker = Schemas["CorrectionBlockerDto"];

/** 拦截明细（缺口日期/金额、受影响计划） */
export type CorrectionBlockerDetail = Schemas["CorrectionBlockerDetailDto"];

/** 逐字段前后对比项 */
export type CorrectionDiffItem = Schemas["CorrectionDiffItemDto"];

// ---------------------------------------------------------------------------
// 账号与数据（account-data）：后端 DataRequest 模块已落地，
// 类型经 bun run generate:api 生成后在此别名。
// ---------------------------------------------------------------------------

/** 数据请求类型（后端 CreateDataRequestDto.type） */
export type DataRequestType = Schemas["CreateDataRequestDto"]["type"];

/** 数据请求视图（后端 DataRequestViewDto，进度页/设置页统一展示模型） */
export type DataRequestView = Schemas["DataRequestViewDto"];

/** 数据请求展示状态（后端 DataRequestViewDto.displayStatus） */
export type DataRequestDisplayStatus =
	Schemas["DataRequestViewDto"]["displayStatus"];

/** 清空影响视图（后端 ImpactViewDto，CLEAR 确认页） */
export type ImpactView = Schemas["ImpactViewDto"];

/** 确认页记录数量快照（后端 ImpactTotalsDto） */
export type ImpactTotals = Schemas["ImpactTotalsDto"];

/** 数据操作验证结果（后端 VerifyResultDto：凭证 + 10 分钟确认截止） */
export type DataRequestVerifyResult = Schemas["VerifyResultDto"];

/** 数据操作验证用途（LOGIN 不放行数据请求） */
export type DataRequestPurpose = Schemas["VerifyDataRequestDto"]["purpose"];
