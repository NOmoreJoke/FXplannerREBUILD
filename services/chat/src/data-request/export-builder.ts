/**
 * 导出包构建层（account-data 技术方案 §3.1 决策二 / §7.5.1）。
 *
 * 纯函数为主：业务行 → CSV 文本条目；ZIP 打包是唯一 IO（jszip）。
 * 口径（需求 6.2）：
 * - 金额标明币种（独立 currencyCode 列）；JPY/KRW 0 位小数、其余 2 位（money 包规则）；
 * - 费用未知（feeAmount=null）导出「未知」，绝不写 0；
 * - 日期一律 ISO 8601 UTC（带时区）；
 * - 各表格通过记录编号互相对应（planId/usageId/sourceId 原样导出）；
 * - 尚未形成的数据注明为空（表头 + 「（无）」注记行）；
 * - 不含验证码、登录凭证或任何他人数据。
 */
import { getCurrency, roundToCurrency } from "@fxplanner-new/money";

// ─────────────────────────────────────────────────────────────
// 行类型（Prisma Decimal 序列化为字符串后进入本层，保持纯函数无 ORM 依赖）
// ─────────────────────────────────────────────────────────────

export interface ExportSettingsRow {
	baseCurrency: string;
	locale: string;
	region: string;
	prepPreference: string;
	reminderEnabled: boolean;
	ledgerStartedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
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
	/** 关联计划编号 */
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
	type: string;
	status: string;
	requestedAt: Date;
	dueAt: Date;
	processedAt: Date | null;
	downloadExpiresAt: Date | null;
}

export interface ExportBundleData {
	generatedAt: Date;
	/** 账号设置（清空/注销前的快照；注销后无 settings 可导出为 null） */
	settings: ExportSettingsRow | null;
	initialHoldings: ExportInitialHoldingRow[];
	transactions: ExportTransactionRow[];
	accounts: ExportAccountRow[];
	plans: ExportPlanRow[];
	planAllocations: ExportPlanAllocationRow[];
	usageRecords: ExportUsageRecordRow[];
	usageLotAllocations: ExportUsageLotAllocationRow[];
	corrections: ExportCorrectionRow[];
	termsConsents: ExportTermsConsentRow[];
	dataRequests: ExportDataRequestRow[];
}

// ─────────────────────────────────────────────────────────────
// 基础格式化
// ─────────────────────────────────────────────────────────────

/** CSV 字段转义：含逗号/引号/换行/回车的字段包裹双引号，内部引号翻倍 */
export function escapeCsvField(value: string): string {
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

/** 使用成本列：一笔使用分摊到多个成本批次的成本合计（先进先出消耗口径） */
export function usageCostOf(
	usageId: string,
	allocations: ExportUsageLotAllocationRow[],
): string {
	const total = allocations
		.filter((row) => row.usageId === usageId)
		.reduce((sum, row) => sum + Number(row.cost), 0);
	return String(total);
}

/**
 * 构建导出包全部文本条目：README + 11 份表格。
 * 首次设置草稿（draft）与报告文件（reports）当前产品不形成存量，
 * 按待确认点 4 固定输出空表注记。
 */
export function buildExportEntries(data: ExportBundleData): ExportEntry[] {
	const entries: ExportEntry[] = [];

	// 1. 阅读说明
	entries.push({ path: "README.txt", content: buildReadme(data) });

	// 2. 账号设置（preferences）
	entries.push({
		path: "01-settings.csv",
		content: data.settings
			? toCsv(
				["字段", "值"],
				[
					["本位币", data.settings.baseCurrency],
					["地区", data.settings.region],
					["语言", data.settings.locale],
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
	entries.push({
		path: "03-initial-holdings.csv",
		content: tableOrEmpty(
			data.initialHoldings,
			[
				"记录编号",
				"币种",
				"数量",
				"汇率",
				"原始汇率",
				"汇率来源",
				"报价时间",
				`成本(${data.settings?.baseCurrency ?? "本位币"})`,
				"确认时间",
			],
			() =>
				toCsv(
					[
						"记录编号",
						"币种",
						"数量",
						"汇率",
						"原始汇率",
						"汇率来源",
						"报价时间",
						`成本(${data.settings?.baseCurrency ?? "本位币"})`,
						"确认时间",
					],
					data.initialHoldings.map((row) => [
						row.id,
						row.currencyCode,
						formatAmount(row.amount, row.currencyCode),
						row.rate,
						row.rawRate,
						row.rateSource,
						formatDateTime(row.rateObservedAt),
						formatAmount(row.cost, data.settings?.baseCurrency ?? "CNY"),
						formatDateTime(row.confirmedAt),
					]),
				),
		),
	});

	// 5. 买入（费用未知 →「未知」）
	entries.push({
		path: "04-transactions.csv",
		content: tableOrEmpty(
			data.transactions,
			[
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
			],
			() =>
				toCsv(
					[
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
					],
					data.transactions.map((row) => [
						row.id,
						row.currencyCode,
						formatAmount(row.quantity, row.currencyCode),
						formatAmount(row.principalAmount, row.currencyCode),
						formatFee(row.feeAmount, row.currencyCode),
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
	entries.push({
		path: "05-accounts.csv",
		content: tableOrEmpty(
			data.accounts,
			["记录编号", "币种", "余额", "创建时间", "更新时间"],
			() =>
				toCsv(
					["记录编号", "币种", "余额", "创建时间", "更新时间"],
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
	entries.push({
		path: "06-plans.csv",
		content: tableOrEmpty(
			data.plans,
			[
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
			],
			() =>
				toCsv(
					[
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
					],
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

	// 8. 计划分配（金额为本位币口径）
	const baseCurrency = data.settings?.baseCurrency ?? "CNY";
	entries.push({
		path: "07-plan-allocations.csv",
		content: tableOrEmpty(
			data.planAllocations,
			["记录编号", "关联计划编号", `分配金额(${baseCurrency})`, `已使用(${baseCurrency})`, "创建时间"],
			() =>
				toCsv(
					["记录编号", "关联计划编号", `分配金额(${baseCurrency})`, `已使用(${baseCurrency})`, "创建时间"],
					data.planAllocations.map((row) => [
						row.id,
						row.planId,
						formatAmount(row.amount, baseCurrency),
						formatAmount(row.usedAmount, baseCurrency),
						formatDateTime(row.createdAt),
					]),
				),
		),
	});

	// 9. 使用记录（附「使用成本」列 = 成本批次分摊合计，§12-8）
	entries.push({
		path: "08-usage-records.csv",
		content: tableOrEmpty(
			data.usageRecords,
			[
				"记录编号",
				"关联计划编号",
				"币种",
				"金额",
				"使用时间",
				"版本",
				`使用成本(${baseCurrency})`,
				"创建时间",
			],
			() =>
				toCsv(
					[
						"记录编号",
						"关联计划编号",
						"币种",
						"金额",
						"使用时间",
						"版本",
						`使用成本(${baseCurrency})`,
						"创建时间",
					],
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
	entries.push({
		path: "09-corrections.csv",
		content: tableOrEmpty(
			data.corrections,
			[
				"记录编号",
				"对象类型",
				"对象编号",
				"原因",
				"状态",
				"失败原因",
				"变更前快照",
				"变更后快照",
				"创建时间",
			],
			() =>
				toCsv(
					[
						"记录编号",
						"对象类型",
						"对象编号",
						"原因",
						"状态",
						"失败原因",
						"变更前快照",
						"变更后快照",
						"创建时间",
					],
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

	// 11. 条款同意记录
	entries.push({
		path: "10-terms-consents.csv",
		content: tableOrEmpty(
			data.termsConsents,
			["记录编号", "条款版本", "同意类型", "同意时间"],
			() =>
				toCsv(
					["记录编号", "条款版本", "同意类型", "同意时间"],
					data.termsConsents.map((row) => [
						row.id,
						row.termsVersion,
						row.consentType,
						formatDateTime(row.consentedAt),
					]),
				),
		),
	});

	// 12. 数据请求记录
	entries.push({
		path: "11-data-requests.csv",
		content: tableOrEmpty(
			data.dataRequests,
			["记录编号", "类型", "状态", "提交时间", "截止时间", "终态时间", "下载失效时间"],
			() =>
				toCsv(
					["记录编号", "类型", "状态", "提交时间", "截止时间", "终态时间", "下载失效时间"],
					data.dataRequests.map((row) => [
						row.id,
						row.type,
						row.status,
						formatDateTime(row.requestedAt),
						formatDateTime(row.dueAt),
						formatDateTime(row.processedAt),
						formatDateTime(row.downloadExpiresAt),
					]),
				),
		),
	});

	// 13. 已有报告文件（当前报告为查看型、无存量文件 → 注明为空，待确认点 4）
	entries.push({
		path: "12-reports.csv",
		content: emptyTableNote(["记录编号", "报告名称", "生成时间"]),
	});

	return entries;
}

/** README 阅读说明：生成时间、口径说明（先进先出、费用未知语义、时区、空表） */
export function buildReadme(data: ExportBundleData): string {
	return [
		"FXPlanner 个人数据导出包",
		"========================",
		"",
		`生成时间：${formatDateTime(data.generatedAt)}（UTC，ISO 8601 带时区）`,
		"",
		"一、包含内容",
		"  01-settings.csv           账号设置（本位币、地区、语言、偏好）",
		"  02-onboarding-draft.csv   首次设置草稿（当前无存量，未形成的数据注明为空）",
		"  03-initial-holdings.csv   初始外币",
		"  04-transactions.csv       买入记录",
		"  05-accounts.csv           外汇账户",
		"  06-plans.csv              换汇计划",
		"  07-plan-allocations.csv   计划分配",
		"  08-usage-records.csv      资金使用记录（附「使用成本」列）",
		"  09-corrections.csv        更正历史（含变更前后快照）",
		"  10-terms-consents.csv     条款同意记录",
		"  11-data-requests.csv      数据请求记录",
		"  12-reports.csv            已有报告文件（当前为查看型、无存量文件，注明为空）",
		"",
		"二、口径说明",
		"  1. 金额一律带币种列；日元/韩元为 0 位小数整数，其余币种保留 2 位小数（四舍五入）。",
		"  2. 手续费未知时显示「未知」，不写 0；「0」仅表示确认无费用。",
		"  3. 所有日期时间为 ISO 8601 格式并带时区（统一 UTC，Z 结尾）。",
		"  4. 各表格通过「记录编号」互相对应：买入/使用的「关联计划编号」对应计划表的记录编号，",
		"     更正表的「对象编号」对应被更正记录的编号。",
		"  5. 使用成本按「先进先出」消耗成本批次计算（08 表「使用成本」列 = 该笔使用",
		"     分摊到的各成本批次成本之和）。",
		"  6. 本包为提交时已成功保存的数据快照；之后新增或修改的内容不在其中。",
		"  7. 隐私说明：本包不含验证码与登录凭证；验证码、密码等安全数据永不导出。",
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
