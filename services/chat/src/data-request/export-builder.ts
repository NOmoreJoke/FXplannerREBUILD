/**
 * 导出包构建层（account-data 技术方案 §3.1 决策二 / §7.5.1；ToB R1 技术方案 §9 双域拆分）。
 *
 * 纯函数为主：业务行 → CSV 文本条目；ZIP 打包是唯一 IO（jszip）。
 * 两个入口互不交叉（需求 DATA-01 语义分离）：
 * - 个人数据导出（buildPersonalExportArchive）：账号资料、个人展示偏好、所属组织
 *   成员摘要、个人会话元数据、条款同意、个人数据请求——**严禁含任何组织账本
 *   财务明细**（交易/持仓/批次/计划/使用/更正一律不出现）；
 * - 组织数据导出（buildOrganizationExportArchive）：当前组织完整账本与报告 CSV。
 * 口径（需求 6.2）：
 * - 金额标明币种（独立 currencyCode 列）；JPY/KRW 0 位小数、其余 2 位（money 包规则）；
 * - 费用未知（feeAmount=null）导出「未知」，绝不写 0；
 * - 日期一律 ISO 8601 UTC（带时区）；
 * - 各表格通过记录编号互相对应（planId/usageId/sourceId 原样导出）；
 * - 尚未形成的数据注明为空（表头 + 「（无）」注记行）；
 * - 不含验证码、登录凭证或任何他人数据；
 * - 金额全链路 Decimal（money 包 / decimal.js），零原生 Number() 浮点混入。
 */
import Decimal from "decimal.js";
import { getCurrency, roundToCurrency } from "@fxplanner-new/money";

// ─────────────────────────────────────────────────────────────
// 行类型（Prisma Decimal 序列化为字符串后进入本层，保持纯函数无 ORM 依赖）
// ─────────────────────────────────────────────────────────────

/** 组织偏好（本位币/准备偏好/提醒开关/记账起点）；时间戳在兼容回落（无组织设置行）时为 null */
export interface ExportSettingsRow {
	baseCurrency: string;
	prepPreference: string;
	reminderEnabled: boolean;
	ledgerStartedAt: Date | null;
	createdAt: Date | null;
	updatedAt: Date | null;
}

export interface ExportOrganizationRow {
	id: string;
	name: string;
	createdAt: Date;
}

export interface ExportInitialHoldingRow {
	id: string;
	currencyCode: string;
	amount: string;
	rate: string;
	rawRate: string;
	rateSource: string;
	rateObservedAt: Date;
	cost: string;
	confirmedAt: Date;
}

export interface ExportTransactionRow {
	id: string;
	currencyCode: string;
	quantity: string;
	principalAmount: string;
	/** null = 未知费用（导出「未知」，不写 0） */
	feeAmount: string | null;
	exchangeRate: string;
	rateSource: string;
	rateObservedAt: Date;
	/** 关联计划编号（跨表对应键） */
	planId: string | null;
	transactedAt: Date;
	version: number;
	createdAt: Date;
}

export interface ExportAccountRow {
	id: string;
	currencyCode: string;
	balance: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface ExportPlanRow {
	id: string;
	name: string | null;
	pacePreference: string;
	targetCurrency: string;
	targetAmount: string;
	expectUseDate: Date;
	prepLeadDays: number;
	latestPrepDate: Date;
	planStartDate: Date | null;
	status: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface ExportPlanAllocationRow {
	id: string;
	/** 关联计划编号（币种经计划的 targetCurrency 解析） */
	planId: string;
	amount: string;
	usedAmount: string;
	createdAt: Date;
}

export interface ExportUsageLotAllocationRow {
	id: string;
	/** 关联使用记录编号 */
	usageId: string;
	/** 关联成本批次编号 */
	lotId: string;
	quantity: string;
	cost: string;
}

export interface ExportUsageRecordRow {
	id: string;
	/** 关联计划编号 */
	planId: string;
	currencyCode: string;
	amount: string;
	usedAt: Date;
	version: number;
	createdAt: Date;
}

export interface ExportCorrectionRow {
	id: string;
	targetType: string;
	targetId: string;
	reason: string;
	status: string;
	failReason: string | null;
	beforeSnapshot: unknown;
	afterSnapshot: unknown;
	createdAt: Date;
}

export interface ExportTermsConsentRow {
	id: string;
	termsVersion: string;
	consentType: string;
	consentedAt: Date;
}

export interface ExportDataRequestRow {
	id: string;
	/** PERSONAL / ORGANIZATION */
	scope: string;
	type: string;
	status: string;
	requestedAt: Date;
	dueAt: Date;
	processedAt: Date | null;
	downloadExpiresAt: Date | null;
}

/** 组织数据导出包输入：当前组织的完整账本与组织数据请求（不含任何成员的个人数据） */
export interface OrganizationExportBundleData {
	generatedAt: Date;
	organization: ExportOrganizationRow;
	/** 组织偏好；未建账为 null */
	settings: ExportSettingsRow | null;
	initialHoldings: ExportInitialHoldingRow[];
	transactions: ExportTransactionRow[];
	accounts: ExportAccountRow[];
	plans: ExportPlanRow[];
	planAllocations: ExportPlanAllocationRow[];
	usageRecords: ExportUsageRecordRow[];
	usageLotAllocations: ExportUsageLotAllocationRow[];
	corrections: ExportCorrectionRow[];
	/** 本组织的数据请求（scope = ORGANIZATION） */
	dataRequests: ExportDataRequestRow[];
}

// ─────────────────────────────────────────────────────────────
// 个人数据导出输入（需求 DATA-01：不含组织财务明细）
// ─────────────────────────────────────────────────────────────

export interface PersonalExportProfileRow {
	id: string;
	email: string | null;
	name: string | null;
	createdAt: Date;
}

/** 个人展示偏好（语言/地区，属个人维度）；无个人设置行为 null */
export interface PersonalExportPreferencesRow {
	locale: string;
	region: string;
}

/** 所属组织成员摘要（仅组织名/角色/状态/加入时间，不含任何账本数据） */
export interface PersonalExportOrganizationRow {
	organizationId: string;
	organizationName: string;
	role: string;
	status: string;
	joinedAt: Date;
}

/** 个人 AI 会话元数据（不含消息正文） */
export interface PersonalExportConversationRow {
	id: string;
	title: string;
	createdAt: Date;
	lastMessageAt: Date;
}

export interface PersonalExportBundleData {
	generatedAt: Date;
	profile: PersonalExportProfileRow;
	preferences: PersonalExportPreferencesRow | null;
	organizations: PersonalExportOrganizationRow[];
	conversations: PersonalExportConversationRow[];
	termsConsents: ExportTermsConsentRow[];
	/** 本人的个人数据请求（scope = PERSONAL） */
	dataRequests: ExportDataRequestRow[];
}

// ─────────────────────────────────────────────────────────────
// 基础格式化
// ─────────────────────────────────────────────────────────────

/**
 * CSV 公式注入中和（R1 I-2）：Excel / LibreOffice / Google Sheets 会把以
 * `=` `+` `-` `@` TAB CR 开头的字段当公式解析（`=cmd|'/C calc'!A0` 可触发 DDE）。
 * 这类字段一律加单引号前缀（`'…`），使表格软件按纯文本处理。
 *
 * 豁免：纯负数（`-12.34`）是合法金额写法，不得被前缀破坏。
 * 中和后的字段整体加双引号（RFC 4180），前缀与内容的边界始终明确。
 */
const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;
const CSV_PURE_NEGATIVE_NUMBER = /^-[0-9]+(\.[0-9]+)?$/;

/** CSV 字段转义：含逗号/引号/换行/回车的字段包裹双引号，内部引号翻倍 */
export function escapeCsvField(value: string): string {
	if (CSV_FORMULA_PREFIX.test(value) && !CSV_PURE_NEGATIVE_NUMBER.test(value)) {
		return `"'${value.replaceAll('"', '""')}"`;
	}
	if (/[",\n\r]/.test(value)) {
		return `"${value.replaceAll('"', '""')}"`;
	}
	return value;
}

/** 行 → CSV 文本（CRLF 兼容 Excel，RFC 4180） */
export function toCsvRow(fields: string[]): string {
	return fields.map(escapeCsvField).join(",");
}

/** 表 → CSV 文本（末尾换行） */
export function toCsv(header: string[], rows: string[][]): string {
	return [toCsvRow(header), ...rows.map(toCsvRow)].join("\r\n") + "\r\n";
}

/** 日期统一 ISO 8601 UTC（带时区标识 Z，需求 6.2-4） */
export function formatDateTime(value: Date | null | undefined): string {
	if (!value) return "";
	return value.toISOString();
}

/** JSON 快照列（更正 before/after）：紧凑序列化，空值为空串 */
function formatJson(value: unknown): string {
	if (value === null || value === undefined) return "";
	return JSON.stringify(value);
}

/** 按币种精度格式化金额（JPY/KRW 0 位、其余 2 位，ROUND_HALF_UP，money 包规则） */
export function formatAmount(
	amount: string | null | undefined,
	currencyCode: string,
): string {
	if (amount === null || amount === undefined || amount === "") return "";
	const decimalPlaces = getCurrency(currencyCode)?.decimalPlaces ?? 2;
	return roundToCurrency(amount, decimalPlaces).toFixed(decimalPlaces);
}

/** 费用格式化：null（未知）→「未知」，绝不写 0（需求 6.2-4） */
export function formatFee(
	feeAmount: string | null,
	currencyCode: string,
): string {
	if (feeAmount === null) return "未知";
	return formatAmount(feeAmount, currencyCode);
}

/** 布尔 → 中文口径 */
function formatBoolean(value: boolean): string {
	return value ? "是" : "否";
}

/** 数据域 → 中文口径 */
function formatScope(scope: string): string {
	return scope === "ORGANIZATION" ? "组织" : "个人";
}

/** 空表输出：表头 + 「（无）」注记行（未形成的数据注明为空，需求 6.2-3） */
function emptyTableNote(header: string[]): string {
	return `${toCsvRow(header)}\r\n${toCsvRow(["（无）"])}\r\n`;
}

function tableOrEmpty(
	rows: readonly unknown[],
	header: string[],
	build: () => string,
): string {
	return rows.length === 0 ? emptyTableNote(header) : build();
}

// ─────────────────────────────────────────────────────────────
// CSV 条目构建
// ─────────────────────────────────────────────────────────────

export interface ExportEntry {
	path: string;
	content: string;
}

/** 使用成本列：一笔使用分摊到多个成本批次的成本合计（先进先出消耗口径）。
 * Decimal 累加（MVP-F0-4）：原生 Number 累加在多批次分摊下存在浮点尾差，
 * 导出为审计账本，必须与账本口径逐位一致 */
export function usageCostOf(
	usageId: string,
	allocations: ExportUsageLotAllocationRow[],
): string {
	const total = allocations
		.filter((row) => row.usageId === usageId)
		.reduce(
			(sum, row) => sum.add(new Decimal(row.cost)),
			new Decimal(0),
		);
	return total.toFixed(4);
}

/** 计划分配行的币种 = 其计划的目标币种（分配额/已使用额均为目标币种口径） */
export function allocationCurrencyOf(
	planId: string,
	plans: readonly Pick<ExportPlanRow, "id" | "targetCurrency">[],
): string | null {
	return plans.find((plan) => plan.id === planId)?.targetCurrency ?? null;
}

const DATA_REQUEST_HEADER = [
	"记录编号",
	"数据域",
	"类型",
	"状态",
	"提交时间",
	"截止时间",
	"终态时间",
	"下载失效时间",
] as const;

function dataRequestsTable(rows: ExportDataRequestRow[]): string {
	return tableOrEmpty(rows, [...DATA_REQUEST_HEADER], () =>
		toCsv(
			[...DATA_REQUEST_HEADER],
			rows.map((row) => [
				row.id,
				formatScope(row.scope),
				row.type,
				row.status,
				formatDateTime(row.requestedAt),
				formatDateTime(row.dueAt),
				formatDateTime(row.processedAt),
				formatDateTime(row.downloadExpiresAt),
			]),
		),
	);
}

// ─────────────────────────────────────────────────────────────
// 组织数据导出（当前组织完整账本与报告）
// ─────────────────────────────────────────────────────────────

/** 计划分配表表头：分配/已使用为目标币种口径，币种独立成列（Goal #2 ③） */
export const PLAN_ALLOCATION_HEADER = [
	"记录编号",
	"关联计划编号",
	"币种",
	"分配金额",
	"已使用",
	"创建时间",
] as const;

/**
 * 构建组织导出包全部文本条目：README + 12 份表格。
 * 首次设置草稿（draft）与报告文件（reports）当前产品不形成存量，
 * 按待确认点 4 固定输出空表注记。
 */
export function buildOrganizationExportEntries(
	data: OrganizationExportBundleData,
): ExportEntry[] {
	const entries: ExportEntry[] = [];

	// 1. 阅读说明
	entries.push({ path: "README.txt", content: buildOrganizationReadme(data) });

	// 2. 组织设置
	const baseCurrency = data.settings?.baseCurrency ?? "CNY";
	entries.push({
		path: "01-settings.csv",
		content: data.settings
			? toCsv(
					["字段", "值"],
					[
						["本位币", data.settings.baseCurrency],
						["准备偏好", data.settings.prepPreference],
						["提醒开关", formatBoolean(data.settings.reminderEnabled)],
						["记账起点", formatDateTime(data.settings.ledgerStartedAt)],
						["创建时间", formatDateTime(data.settings.createdAt)],
						["更新时间", formatDateTime(data.settings.updatedAt)],
					],
				)
			: emptyTableNote(["字段", "值"]),
	});

	// 3. 首次设置草稿（当前产品不落草稿，恒空——待确认点 4 同类口径）
	entries.push({
		path: "02-onboarding-draft.csv",
		content: emptyTableNote(["字段", "值"]),
	});

	// 4. 初始外币
	const holdingHeader = [
		"记录编号",
		"币种",
		"数量",
		"汇率",
		"原始汇率",
		"汇率来源",
		"报价时间",
		`成本(${baseCurrency})`,
		"确认时间",
	];
	entries.push({
		path: "03-initial-holdings.csv",
		content: tableOrEmpty(data.initialHoldings, holdingHeader, () =>
			toCsv(
				holdingHeader,
				data.initialHoldings.map((row) => [
					row.id,
					row.currencyCode,
					formatAmount(row.amount, row.currencyCode),
					row.rate,
					row.rawRate,
					row.rateSource,
					formatDateTime(row.rateObservedAt),
					formatAmount(row.cost, baseCurrency),
					formatDateTime(row.confirmedAt),
				]),
			),
		),
	});

	// 5. 买入（费用未知 →「未知」）
	const transactionHeader = [
		"记录编号",
		"币种",
		"数量",
		"本金",
		"手续费",
		"汇率",
		"汇率来源",
		"报价时间",
		"关联计划编号",
		"交易时间",
		"版本",
		"创建时间",
	];
	entries.push({
		path: "04-transactions.csv",
		content: tableOrEmpty(data.transactions, transactionHeader, () =>
			toCsv(
				transactionHeader,
				data.transactions.map((row) => [
					row.id,
					row.currencyCode,
					// 数量 = 外币精度（JPY/KRW 0 位）；本金/手续费 = 本位币精度（2 位），
					// 不可沿用外币 currencyCode（MVP-F0-4：JPY 买入时 CNY 本金曾被截为 0 位）
					formatAmount(row.quantity, row.currencyCode),
					formatAmount(row.principalAmount, baseCurrency),
					formatFee(row.feeAmount, baseCurrency),
					row.exchangeRate,
					row.rateSource,
					formatDateTime(row.rateObservedAt),
					row.planId ?? "",
					formatDateTime(row.transactedAt),
					String(row.version),
					formatDateTime(row.createdAt),
				]),
			),
		),
	});

	// 6. 账户
	const accountHeader = ["记录编号", "币种", "余额", "创建时间", "更新时间"];
	entries.push({
		path: "05-accounts.csv",
		content: tableOrEmpty(data.accounts, accountHeader, () =>
			toCsv(
				accountHeader,
				data.accounts.map((row) => [
					row.id,
					row.currencyCode,
					formatAmount(row.balance, row.currencyCode),
					formatDateTime(row.createdAt),
					formatDateTime(row.updatedAt),
				]),
			),
		),
	});

	// 7. 计划
	const planHeader = [
		"记录编号",
		"名称",
		"目标币种",
		"目标金额",
		"期望用汇日",
		"准备提前天数",
		"节奏偏好",
		"最晚开始准备日",
		"排期开始日",
		"状态",
		"创建时间",
		"更新时间",
	];
	entries.push({
		path: "06-plans.csv",
		content: tableOrEmpty(data.plans, planHeader, () =>
			toCsv(
				planHeader,
				data.plans.map((row) => [
					row.id,
					row.name ?? "",
					row.targetCurrency,
					formatAmount(row.targetAmount, row.targetCurrency),
					formatDateTime(row.expectUseDate),
					String(row.prepLeadDays),
					row.pacePreference,
					formatDateTime(row.latestPrepDate),
					formatDateTime(row.planStartDate),
					row.status,
					formatDateTime(row.createdAt),
					formatDateTime(row.updatedAt),
				]),
			),
		),
	});

	// 8. 计划分配（Goal #2 ③ 精度修复）：分配额/已使用额是**计划目标币种**口径，
	//    此前误用本位币格式化（JPY 计划被截成 0 位 / USD 计划被按 CNY 位数舍入）。
	//    币种经关联计划的 targetCurrency 解析并独立成列；解析不到计划（孤儿行）时
	//    不猜测精度，原样输出库内定点值、币种留空。
	entries.push({
		path: "07-plan-allocations.csv",
		content: tableOrEmpty(
			data.planAllocations,
			[...PLAN_ALLOCATION_HEADER],
			() =>
				toCsv(
					[...PLAN_ALLOCATION_HEADER],
					data.planAllocations.map((row) => {
						const currency = allocationCurrencyOf(row.planId, data.plans);
						return [
							row.id,
							row.planId,
							currency ?? "",
							currency ? formatAmount(row.amount, currency) : row.amount,
							currency ? formatAmount(row.usedAmount, currency) : row.usedAmount,
							formatDateTime(row.createdAt),
						];
					}),
				),
		),
	});

	// 9. 使用记录（附「使用成本」列 = 成本批次分摊合计，§12-8）
	const usageHeader = [
		"记录编号",
		"关联计划编号",
		"币种",
		"金额",
		"使用时间",
		"版本",
		`使用成本(${baseCurrency})`,
		"创建时间",
	];
	entries.push({
		path: "08-usage-records.csv",
		content: tableOrEmpty(data.usageRecords, usageHeader, () =>
			toCsv(
				usageHeader,
				data.usageRecords.map((row) => [
					row.id,
					row.planId,
					row.currencyCode,
					formatAmount(row.amount, row.currencyCode),
					formatDateTime(row.usedAt),
					String(row.version),
					formatAmount(
						usageCostOf(row.id, data.usageLotAllocations),
						baseCurrency,
					),
					formatDateTime(row.createdAt),
				]),
			),
		),
	});

	// 10. 更正
	const correctionHeader = [
		"记录编号",
		"对象类型",
		"对象编号",
		"原因",
		"状态",
		"失败原因",
		"变更前快照",
		"变更后快照",
		"创建时间",
	];
	entries.push({
		path: "09-corrections.csv",
		content: tableOrEmpty(data.corrections, correctionHeader, () =>
			toCsv(
				correctionHeader,
				data.corrections.map((row) => [
					row.id,
					row.targetType,
					row.targetId,
					row.reason,
					row.status,
					row.failReason ?? "",
					formatJson(row.beforeSnapshot),
					formatJson(row.afterSnapshot),
					formatDateTime(row.createdAt),
				]),
			),
		),
	});

	// 11. 组织信息
	const organizationHeader = ["组织编号", "组织名称", "创建时间"];
	entries.push({
		path: "10-organization.csv",
		content: toCsv(organizationHeader, [
			[
				data.organization.id,
				data.organization.name,
				formatDateTime(data.organization.createdAt),
			],
		]),
	});

	// 12. 数据请求记录（本组织）
	entries.push({
		path: "11-data-requests.csv",
		content: dataRequestsTable(data.dataRequests),
	});

	// 13. 已有报告文件（当前报告为查看型、无存量文件 → 注明为空，待确认点 4）
	entries.push({
		path: "12-reports.csv",
		content: emptyTableNote(["记录编号", "报告名称", "生成时间"]),
	});

	return entries;
}

/** 组织包 README：组织、生成时间、口径说明（目标币种口径、先进先出、费用未知语义、时区、空表） */
export function buildOrganizationReadme(
	data: OrganizationExportBundleData,
): string {
	return [
		"FXPlanner 组织数据导出包",
		"==========================",
		"",
		`组织：${data.organization.name}（${data.organization.id}）`,
		`生成时间：${formatDateTime(data.generatedAt)}（UTC，ISO 8601 带时区）`,
		"",
		"一、包含内容",
		"  01-settings.csv           组织设置（本位币、准备偏好、提醒开关、记账起点）",
		"  02-onboarding-draft.csv   首次设置草稿（当前无存量，未形成的数据注明为空）",
		"  03-initial-holdings.csv   初始外币",
		"  04-transactions.csv       买入记录",
		"  05-accounts.csv           外汇账户",
		"  06-plans.csv              换汇计划",
		"  07-plan-allocations.csv   计划分配（目标币种口径，见「币种」列）",
		"  08-usage-records.csv      资金使用记录（附「使用成本」列）",
		"  09-corrections.csv        更正历史（含变更前后快照）",
		"  10-organization.csv       组织信息",
		"  11-data-requests.csv      本组织的数据请求记录",
		"  12-reports.csv            已有报告文件（当前为查看型、无存量文件，注明为空）",
		"",
		"二、口径说明",
		"  1. 金额一律带币种列；日元/韩元为 0 位小数整数，其余币种保留 2 位小数（四舍五入）。",
		"  2. 计划分配表的「分配金额」「已使用」为其所属计划的**目标币种**金额，币种见「币种」列，",
		"     与本位币无关。",
		"  3. 手续费未知时显示「未知」，不写 0；「0」仅表示确认无费用。",
		"  4. 所有日期时间为 ISO 8601 格式并带时区（统一 UTC，Z 结尾）。",
		"  5. 各表格通过「记录编号」互相对应：买入/使用的「关联计划编号」对应计划表的记录编号，",
		"     更正表的「对象编号」对应被更正记录的编号。",
		"  6. 使用成本按「先进先出」消耗成本批次计算（08 表「使用成本」列 = 该笔使用",
		"     分摊到的各成本批次成本之和）。",
		"  7. 本包为提交时已成功保存的数据快照；之后新增或修改的内容不在其中。",
		"  8. 本包只含组织账本数据，不含任何成员的个人资料与个人会话内容；个人数据请使用个人数据导出。",
		"  9. 隐私说明：本包不含验证码与登录凭证；验证码、密码等安全数据永不导出。",
		"",
	].join("\n");
}

// ─────────────────────────────────────────────────────────────
// 个人数据导出（DATA-01：账号资料、个人偏好、成员关系、个人会话元数据）
// ─────────────────────────────────────────────────────────────

/** 个人包的全部条目路径（隔离断言用：个人包不得出现任何账本表格） */
export const PERSONAL_EXPORT_PATHS = [
	"README.txt",
	"01-profile.csv",
	"02-preferences.csv",
	"03-organizations.csv",
	"04-conversations.csv",
	"05-terms-consents.csv",
	"06-data-requests.csv",
] as const;

/** 组织包中属于账本财务明细的条目（个人包隔离断言用） */
export const ORGANIZATION_LEDGER_PATHS = [
	"03-initial-holdings.csv",
	"04-transactions.csv",
	"05-accounts.csv",
	"06-plans.csv",
	"07-plan-allocations.csv",
	"08-usage-records.csv",
	"09-corrections.csv",
] as const;

/** 构建个人导出包全部文本条目：README + 6 份表格（零账本明细） */
export function buildPersonalExportEntries(
	data: PersonalExportBundleData,
): ExportEntry[] {
	const entries: ExportEntry[] = [];

	entries.push({ path: "README.txt", content: buildPersonalReadme(data) });

	const profileHeader = ["用户编号", "邮箱", "姓名", "注册时间"];
	entries.push({
		path: "01-profile.csv",
		content: toCsv(profileHeader, [
			[
				data.profile.id,
				data.profile.email ?? "",
				data.profile.name ?? "",
				formatDateTime(data.profile.createdAt),
			],
		]),
	});

	const preferenceHeader = ["语言", "地区"];
	entries.push({
		path: "02-preferences.csv",
		content: data.preferences
			? toCsv(preferenceHeader, [
					[data.preferences.locale, data.preferences.region],
				])
			: emptyTableNote(preferenceHeader),
	});

	const organizationHeader = [
		"组织编号",
		"组织名称",
		"角色",
		"成员状态",
		"加入时间",
	];
	entries.push({
		path: "03-organizations.csv",
		content: tableOrEmpty(data.organizations, organizationHeader, () =>
			toCsv(
				organizationHeader,
				data.organizations.map((row) => [
					row.organizationId,
					row.organizationName,
					row.role,
					row.status,
					formatDateTime(row.joinedAt),
				]),
			),
		),
	});

	const conversationHeader = ["会话编号", "标题", "创建时间", "最后消息时间"];
	entries.push({
		path: "04-conversations.csv",
		content: tableOrEmpty(data.conversations, conversationHeader, () =>
			toCsv(
				conversationHeader,
				data.conversations.map((row) => [
					row.id,
					row.title,
					formatDateTime(row.createdAt),
					formatDateTime(row.lastMessageAt),
				]),
			),
		),
	});

	const consentHeader = ["记录编号", "条款版本", "同意类型", "同意时间"];
	entries.push({
		path: "05-terms-consents.csv",
		content: tableOrEmpty(data.termsConsents, consentHeader, () =>
			toCsv(
				consentHeader,
				data.termsConsents.map((row) => [
					row.id,
					row.termsVersion,
					row.consentType,
					formatDateTime(row.consentedAt),
				]),
			),
		),
	});

	entries.push({
		path: "06-data-requests.csv",
		content: dataRequestsTable(data.dataRequests),
	});

	return entries;
}

/** 个人包 README：生成时间、包含内容与「不含组织财务明细」声明 */
export function buildPersonalReadme(data: PersonalExportBundleData): string {
	return [
		"FXPlanner 个人数据导出包",
		"========================",
		"",
		`生成时间：${formatDateTime(data.generatedAt)}（UTC，ISO 8601 带时区）`,
		"",
		"一、包含内容",
		"  01-profile.csv            账号资料（邮箱、姓名、注册时间）",
		"  02-preferences.csv        个人展示偏好（语言、地区）",
		"  03-organizations.csv      所属组织摘要（组织名称、角色、成员状态、加入时间）",
		"  04-conversations.csv      个人会话元数据（标题与时间，不含消息正文）",
		"  05-terms-consents.csv     条款同意记录",
		"  06-data-requests.csv      个人数据请求记录",
		"",
		"二、口径说明",
		"  1. 本包只含你的个人数据。组织账本的交易、持仓、成本批次、计划、资金使用与更正",
		"     属于组织数据，不在本包内；如需导出，请在对应组织中使用「组织数据导出」。",
		"  2. 所有日期时间为 ISO 8601 格式并带时区（统一 UTC，Z 结尾）。",
		"  3. 未形成的数据以「（无）」注明为空。",
		"  4. 本包为提交时已成功保存的数据快照；之后新增或修改的内容不在其中。",
		"  5. 隐私说明：本包不含验证码与登录凭证；验证码、密码等安全数据永不导出。",
		"",
	].join("\n");
}

// ─────────────────────────────────────────────────────────────
// ZIP 打包（唯一 IO）
// ─────────────────────────────────────────────────────────────

/** 文本条目 → ZIP 二进制（jszip 同步入口，nodebuffer 便于落盘与流式返回） */
export async function buildExportZip(entries: ExportEntry[]): Promise<Buffer> {
	const JSZip = (await import("jszip")).default;
	const zip = new JSZip();
	for (const entry of entries) {
		zip.file(entry.path, entry.content, { date: new Date() });
	}
	return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** 个人数据导出包（ZIP） */
export async function buildPersonalExportArchive(
	data: PersonalExportBundleData,
): Promise<Buffer> {
	return buildExportZip(buildPersonalExportEntries(data));
}

/** 组织数据导出包（ZIP） */
export async function buildOrganizationExportArchive(
	data: OrganizationExportBundleData,
): Promise<Buffer> {
	return buildExportZip(buildOrganizationExportEntries(data));
}
