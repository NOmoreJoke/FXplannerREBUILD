import { describe, expect, it } from "vitest";
import {
	buildExportEntries,
	buildExportZip,
	buildReadme,
	escapeCsvField,
	formatAmount,
	formatDateTime,
	formatFee,
	toCsv,
	usageCostOf,
	type ExportBundleData,
} from "./export-builder";

const T0 = new Date("2026-06-01T08:30:00.000Z");

function bundleData(patch: Partial<ExportBundleData> = {}): ExportBundleData {
	return {
		generatedAt: T0,
		settings: {
			baseCurrency: "CNY",
			locale: "zh-CN",
			region: "CN",
			prepPreference: "balanced",
			reminderEnabled: true,
			ledgerStartedAt: T0,
			createdAt: T0,
			updatedAt: T0,
		},
		initialHoldings: [],
		transactions: [],
		accounts: [],
		plans: [],
		planAllocations: [],
		usageRecords: [],
		usageLotAllocations: [],
		corrections: [],
		termsConsents: [],
		dataRequests: [],
		...patch,
	};
}

describe("export-builder 基础格式化", () => {
	it("CSV 转义：含逗号/引号/换行的字段正确转义", () => {
		expect(escapeCsvField("plain")).toBe("plain");
		expect(escapeCsvField("a,b")).toBe('"a,b"');
		expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
		expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
		expect(toCsv(["name", "note"], [["日本计划,JPY", '含"引号"']])).toBe(
			'name,note\r\n"日本计划,JPY","含""引号"""\r\n',
		);
	});

	it("日期 ISO 8601 带时区（UTC）", () => {
		expect(formatDateTime(T0)).toBe("2026-06-01T08:30:00.000Z");
		expect(formatDateTime(null)).toBe("");
	});

	it("金额按币种精度：JPY/KRW 0 位，其余 2 位（ROUND_HALF_UP）", () => {
		expect(formatAmount("100.5", "JPY")).toBe("101"); // 0 位 half-up：0.5 进位
		expect(formatAmount("100.005", "KRW")).toBe("100"); // 0 位：不足 0.5 不进位
		expect(formatAmount("100.005", "USD")).toBe("100.01");
		expect(formatAmount("1234.5", "CNY")).toBe("1234.50");
		expect(formatAmount(null, "CNY")).toBe("");
	});

	it("费用未知显示「未知」而非 0；0 显示 0", () => {
		expect(formatFee(null, "USD")).toBe("未知");
		expect(formatFee("0", "USD")).toBe("0.00");
		expect(formatFee("12.345", "USD")).toBe("12.35"); // half-up
	});

	it("使用成本 = 分摊成本批次之和（Decimal 累加，4 位定点字符串）", () => {
		const allocations = [
			{ id: "a1", usageId: "u1", lotId: "l1", quantity: "1", cost: "30.50" },
			{ id: "a2", usageId: "u1", lotId: "l2", quantity: "1", cost: "19.50" },
			{ id: "a3", usageId: "u2", lotId: "l1", quantity: "1", cost: "99" },
		];
		expect(usageCostOf("u1", allocations)).toBe("50.0000");
		expect(usageCostOf("u2", allocations)).toBe("99.0000");
		expect(usageCostOf("u-none", allocations)).toBe("0.0000");
	});

	it("使用成本 Decimal 累加无浮点尾差（Number 累加在 0.1×10 场景产生 0.9999…）", () => {
		// 0.1 + 0.1 × 9 的 Number 累加 = 0.9999999999999999；Decimal 逐位精确
		const allocations = Array.from({ length: 10 }, (_, index) => ({
			id: `a${index}`,
			usageId: "u-drift",
			lotId: `l${index}`,
			quantity: "0.1",
			cost: "0.1",
		}));
		// Number 参照（证明该夹具确实暴露浮点尾差，防同义反复）
		const numberSum = allocations.reduce(
			(sum, row) => sum + Number(row.cost),
			0,
		);
		expect(numberSum).not.toBe(1);
		// Decimal 内核逐位一致
		expect(usageCostOf("u-drift", allocations)).toBe("1.0000");
	});
});

describe("export-builder CSV 本位币精度（MVP-F0-4）", () => {
	it("JPY 买入交易 + CNY 本位币：数量 0 位、本金/手续费 2 位（不沿用外币精度）", () => {
		const data = bundleData({
			settings: {
				baseCurrency: "CNY",
				locale: "zh-CN",
				region: "CN",
				prepPreference: "balanced",
				reminderEnabled: true,
				ledgerStartedAt: T0,
				createdAt: T0,
				updatedAt: T0,
			},
			transactions: [
				{
					id: "tx-jpy",
					currencyCode: "JPY",
					quantity: "100000",
					principalAmount: "6500.5",
					feeAmount: "65.005",
					exchangeRate: "0.06500500",
					rateSource: "abc",
					rateObservedAt: T0,
					planId: null,
					transactedAt: T0,
					version: 1,
					createdAt: T0,
				},
			],
		});
		const entries = buildExportEntries(data);
		const txEntry = entries.find(
			(entry) => entry.path === "04-transactions.csv",
		)!;
		// 数量列 = JPY 0 位（100000）；本金 = CNY 2 位（6500.50）；
		// 手续费 = CNY 2 位（65.005 half-up → 65.01），非 JPY 0 位截断（6501）
		expect(txEntry.content).toContain("100000");
		expect(txEntry.content).toContain(",6500.50,");
		expect(txEntry.content).toContain(",65.01,");
		expect(txEntry.content).not.toContain("6501"); // 排除 0 位 half-up 形态
	});
});

describe("export-builder 空数据导出", () => {
	it("未形成的表格输出表头 + 「（无）」注记行", () => {
		const entries = buildExportEntries(bundleData());
		// README + 11 份规格表格（settings/draft/initial/tx/accounts/plans/
		// alloc/usage/corrections/terms/data-requests）+ reports 注记表 = 13 条目
		expect(entries).toHaveLength(13);
		const byPath = new Map(entries.map((e) => [e.path, e.content]));
		for (const path of [
			"01-settings.csv",
			"02-onboarding-draft.csv",
			"03-initial-holdings.csv",
			"04-transactions.csv",
			"05-accounts.csv",
			"06-plans.csv",
			"07-plan-allocations.csv",
			"08-usage-records.csv",
			"09-corrections.csv",
			"10-terms-consents.csv",
			"11-data-requests.csv",
			"12-reports.csv",
		]) {
			expect(byPath.has(path)).toBe(true);
		}
		// draft：表头 + （无）
		expect(byPath.get("02-onboarding-draft.csv")).toBe(
			"字段,值\r\n（无）\r\n",
		);
		// 空业务表：业务表头 + （无）
		expect(byPath.get("04-transactions.csv")).toContain("（无）");
	});

	it("README 含生成时间与口径说明", () => {
		const readme = buildReadme(bundleData());
		expect(readme).toContain("2026-06-01T08:30:00.000Z");
		expect(readme).toContain("先进先出");
		expect(readme).toContain("未知");
		expect(readme).toContain("UTC");
		expect(readme).not.toContain("undefined");
	});
});

describe("export-builder 有数据导出", () => {
	const data = bundleData({
		transactions: [
			{
				id: "tx-1",
				currencyCode: "JPY",
				quantity: "100000.0000",
				principalAmount: "5000.0000",
				feeAmount: null, // 未知手续费
				exchangeRate: "0.0480000000",
				rateSource: "abc",
				rateObservedAt: T0,
				planId: "plan-9",
				transactedAt: T0,
				version: 1,
				createdAt: T0,
			},
			{
				id: "tx-2",
				currencyCode: "USD",
				quantity: "100.0000",
				principalAmount: "720.0000",
				feeAmount: "0",
				exchangeRate: "7.2000000000",
				rateSource: "abc",
				rateObservedAt: T0,
				planId: null,
				transactedAt: T0,
				version: 2,
				createdAt: T0,
			},
		],
		plans: [
			{
				id: "plan-9",
				name: "日本之行, 秋季", // 含逗号，验证转义
				pacePreference: "balanced",
				targetCurrency: "JPY",
				targetAmount: "100000.0000",
				expectUseDate: T0,
				prepLeadDays: 3,
				latestPrepDate: T0,
				planStartDate: T0,
				status: "ACTIVE",
				createdAt: T0,
				updatedAt: T0,
			},
		],
		usageRecords: [
			{
				id: "u-1",
				planId: "plan-9",
				currencyCode: "JPY",
				amount: "30000.0000",
				usedAt: T0,
				version: 1,
				createdAt: T0,
			},
		],
		usageLotAllocations: [
			{ id: "ula-1", usageId: "u-1", lotId: "lot-1", quantity: "30000", cost: "1500.25" },
		],
		dataRequests: [
			{
				id: "dr-1",
				type: "EXPORT",
				status: "COMPLETED",
				requestedAt: T0,
				dueAt: T0,
				processedAt: T0,
				downloadExpiresAt: T0,
			},
		],
	});

	it("买入表：JPY 金额 0 位小数、未知费用「未知」、跨表编号可互查", () => {
		const entries = buildExportEntries(data);
		const tx = entries.find((e) => e.path === "04-transactions.csv")!;
		expect(tx.content).toContain("tx-1");
		expect(tx.content).toContain("100000"); // JPY 0 位
		expect(tx.content).toContain("未知"); // feeAmount=null
		expect(tx.content).toContain("plan-9"); // 跨表编号
		expect(tx.content).toContain("720.00"); // USD 2 位
		expect(tx.content).toContain("0.00"); // fee=0 显示 0
	});

	it("计划表：金额带币种精度、名称逗号被转义", () => {
		const entries = buildExportEntries(data);
		const plans = entries.find((e) => e.path === "06-plans.csv")!;
		expect(plans.content).toContain('"日本之行, 秋季"');
		expect(plans.content).toContain("100000");
	});

	it("使用记录表附使用成本列（本位币口径）", () => {
		const entries = buildExportEntries(data);
		const usage = entries.find((e) => e.path === "08-usage-records.csv")!;
		expect(usage.content).toContain("使用成本(CNY)");
		expect(usage.content).toContain("1500.25");
		expect(usage.content).toContain("plan-9");
	});

	it("数据请求表含导出记录自身", () => {
		const entries = buildExportEntries(data);
		const dr = entries.find((e) => e.path === "11-data-requests.csv")!;
		expect(dr.content).toContain("dr-1");
		expect(dr.content).toContain("EXPORT");
	});

	it("settings 表导出账号偏好", () => {
		const entries = buildExportEntries(data);
		const settings = entries.find((e) => e.path === "01-settings.csv")!;
		expect(settings.content).toContain("CNY");
		expect(settings.content).toContain("2026-06-01T08:30:00.000Z");
	});

	it("settings 为 null 时（注销后导出兜底）输出空表注记", () => {
		const entries = buildExportEntries(bundleData({ settings: null }));
		const settings = entries.find((e) => e.path === "01-settings.csv")!;
		expect(settings.content).toContain("（无）");
	});
});

describe("export-builder ZIP 打包", () => {
	it("文本条目打包为合法 ZIP（PK 头）且条目齐全", async () => {
		const buffer = await buildExportZip([
			{ path: "README.txt", content: "hello" },
			{ path: "01-settings.csv", content: "a,b\r\n1,2\r\n" },
		]);
		expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");
		expect(buffer.length).toBeGreaterThan(0);

		// 用 jszip 读回验证条目
		const JSZip = (await import("jszip")).default;
		const zip = await JSZip.loadAsync(buffer);
		expect(Object.keys(zip.files).sort()).toEqual([
			"01-settings.csv",
			"README.txt",
		]);
		expect(await zip.files["README.txt"].async("string")).toBe("hello");
	});
});
