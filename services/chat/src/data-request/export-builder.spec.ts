import { describe, expect, it } from "vitest";
import {
	allocationCurrencyOf,
	buildOrganizationExportEntries,
	buildOrganizationExportArchive,
	buildOrganizationReadme,
	buildPersonalExportArchive,
	buildPersonalExportEntries,
	buildPersonalReadme,
	buildExportZip,
	escapeCsvField,
	formatAmount,
	formatDateTime,
	formatFee,
	ORGANIZATION_LEDGER_PATHS,
	PERSONAL_EXPORT_PATHS,
	PLAN_ALLOCATION_HEADER,
	toCsv,
	usageCostOf,
	type ExportDataRequestRow,
	type ExportSettingsRow,
	type OrganizationExportBundleData,
	type PersonalExportBundleData,
} from "./export-builder";

const T0 = new Date("2026-06-01T08:30:00.000Z");

function orgSettings(patch: Partial<ExportSettingsRow> = {}): ExportSettingsRow {
	return {
		baseCurrency: "CNY",
		prepPreference: "balanced",
		reminderEnabled: true,
		ledgerStartedAt: T0,
		createdAt: T0,
		updatedAt: T0,
		...patch,
	};
}

function bundleData(
	patch: Partial<OrganizationExportBundleData> = {},
): OrganizationExportBundleData {
	return {
		generatedAt: T0,
		organization: {
			id: "org-1",
			name: "测试组织",
			createdAt: T0,
		},
		settings: orgSettings(),
		initialHoldings: [],
		transactions: [],
		accounts: [],
		plans: [],
		planAllocations: [],
		usageRecords: [],
		usageLotAllocations: [],
		corrections: [],
		dataRequests: [],
		...patch,
	};
}

function requestRow(
	patch: Partial<ExportDataRequestRow> = {},
): ExportDataRequestRow {
	return {
		id: "dr-1",
		scope: "ORGANIZATION",
		type: "EXPORT",
		status: "COMPLETED",
		requestedAt: T0,
		dueAt: T0,
		processedAt: T0,
		downloadExpiresAt: T0,
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
			settings: orgSettings({ baseCurrency: "CNY" }),
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
		const entries = buildOrganizationExportEntries(data);
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

describe("export-builder 07-plan-allocations.csv 按计划目标币种精度（Goal #2 ③）", () => {
	const jpyPlan = {
		id: "plan-jpy",
		name: "日本之行",
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
	};
	const usdPlan = { ...jpyPlan, id: "plan-usd", name: "US Trip", targetCurrency: "USD" };

	it("表头新增「币种」列且不再把本位币写进金额列名", () => {
		expect([...PLAN_ALLOCATION_HEADER]).toEqual([
			"记录编号",
			"关联计划编号",
			"币种",
			"分配金额",
			"已使用",
			"创建时间",
		]);
		const csv = buildOrganizationExportEntries(bundleData()).find(
			(entry) => entry.path === "07-plan-allocations.csv",
		)!.content;
		expect(csv).toContain("记录编号,关联计划编号,币种,分配金额,已使用,创建时间");
		expect(csv).not.toContain("(CNY)");
	});

	it("JPY 计划 0 位、USD 计划 2 位：同一张表内按各自 targetCurrency 精确格式化（逐行精确断言）", () => {
		const data = bundleData({
			// 本位币 CNY（2 位）：修复前 JPY 行会被按 2 位格式化
			settings: orgSettings({ baseCurrency: "CNY" }),
			plans: [jpyPlan, usdPlan],
			planAllocations: [
				{
					id: "alloc-jpy",
					planId: "plan-jpy",
					amount: "100000.4000", // JPY 0 位 half-up → 100000
					usedAmount: "333.6000", //  JPY 0 位 half-up → 334
					createdAt: T0,
				},
				{
					id: "alloc-usd",
					planId: "plan-usd",
					amount: "1234.5678", // USD 2 位 half-up → 1234.57
					usedAmount: "0.0050", //  USD 2 位 half-up → 0.01
					createdAt: T0,
				},
			],
		});
		const csv = buildOrganizationExportEntries(data).find(
			(entry) => entry.path === "07-plan-allocations.csv",
		)!.content;
		const lines = csv.split("\r\n");
		// 末尾换行产生一个空串：表头 + 2 行 + 结尾
		expect(lines).toHaveLength(4);
		expect(lines[0]).toBe("记录编号,关联计划编号,币种,分配金额,已使用,创建时间");
		expect(lines[1]).toBe(
			`alloc-jpy,plan-jpy,JPY,100000,334,${formatDateTime(T0)}`,
		);
		expect(lines[2]).toBe(
			`alloc-usd,plan-usd,USD,1234.57,0.01,${formatDateTime(T0)}`,
		);
		expect(lines[3]).toBe("");
		// 回归钉：修复前误用本位币时 JPY 行会输出 100000.40 / 333.60
		expect(csv).not.toContain("100000.40");
		expect(csv).not.toContain("333.60");
	});

	it("零原生 Number()：十进制半值与二进制浮点分歧处按十进制 half-up（Number 会给另一结果）", () => {
		const data = bundleData({
			plans: [usdPlan, jpyPlan],
			planAllocations: [
				{
					id: "alloc-a",
					planId: "plan-usd",
					amount: "1.2550", // 十进制 half-up 1.26；二进制近似 1.254999… → Number 给 1.25
					usedAmount: "1.0050", // 十进制 half-up 1.01；二进制近似 1.004999… → Number 给 1.00
					createdAt: T0,
				},
				{
					id: "alloc-b",
					planId: "plan-jpy",
					amount: "2.5000", // JPY 0 位 half-up → 3（与 Number 同解，作一致性对照）
					usedAmount: "0.5000", // JPY 0 位 half-up → 1
					createdAt: T0,
				},
			],
		});
		// Number 参照：证明夹具确实落在浮点与十进制分歧处（防同义反复）
		expect(Number("1.2550").toFixed(2)).toBe("1.25");
		expect(Number("1.0050").toFixed(2)).toBe("1.00");

		const csv = buildOrganizationExportEntries(data).find(
			(entry) => entry.path === "07-plan-allocations.csv",
		)!.content;
		expect(csv).toContain("alloc-a,plan-usd,USD,1.26,1.01,");
		expect(csv).toContain("alloc-b,plan-jpy,JPY,3,1,");
		// Number 路径会产出的形态一律不得出现
		expect(csv).not.toContain(",1.25,");
		expect(csv).not.toContain(",1.00,");
	});

	it("分配额币种解析：以关联计划的 targetCurrency 为准；孤儿分配行不猜测精度", () => {
		expect(allocationCurrencyOf("plan-jpy", [jpyPlan, usdPlan])).toBe("JPY");
		expect(allocationCurrencyOf("plan-usd", [jpyPlan, usdPlan])).toBe("USD");
		expect(allocationCurrencyOf("plan-missing", [jpyPlan])).toBeNull();

		const csv = buildOrganizationExportEntries(
			bundleData({
				plans: [jpyPlan],
				planAllocations: [
					{ id: "alloc-orphan", planId: "plan-missing", amount: "12.3456", usedAmount: "0.0000", createdAt: T0 },
				],
			}),
		).find((entry) => entry.path === "07-plan-allocations.csv")!.content;
		// 原样输出库内定点值（4 位），币种留空——不冒充任何币种精度
		expect(csv).toContain("alloc-orphan,plan-missing,,12.3456,0.0000,");
	});
});

describe("export-builder 空数据导出", () => {
	it("未形成的表格输出表头 + 「（无）」注记行", () => {
		const entries = buildOrganizationExportEntries(bundleData());
		// README + 11 份表格（settings/draft/initial/tx/accounts/plans/alloc/
		// usage/corrections/organization/data-requests）+ reports 注记表 = 13 条目
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
			"10-organization.csv",
			"11-data-requests.csv",
			"12-reports.csv",
		]) {
			expect(byPath.has(path), path).toBe(true);
		}
		// draft：表头 + （无）
		expect(byPath.get("02-onboarding-draft.csv")).toBe(
			"字段,值\r\n（无）\r\n",
		);
		// 空业务表：业务表头 + （无）
		expect(byPath.get("04-transactions.csv")).toContain("（无）");
		// 条目路径互不重复
		expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length);
	});

	it("README 含组织、生成时间与口径说明", () => {
		const readme = buildOrganizationReadme(bundleData());
		expect(readme).toContain("FXPlanner 组织数据导出包");
		expect(readme).toContain("测试组织");
		expect(readme).toContain("2026-06-01T08:30:00.000Z");
		expect(readme).toContain("目标币种");
		expect(readme).toContain("先进先出");
		expect(readme).toContain("未知");
		expect(readme).toContain("UTC");
		expect(readme).toContain("个人数据导出");
		expect(readme).not.toContain("undefined");
	});

	it("组织设置为 null（未建账）时输出空表注记", () => {
		const entries = buildOrganizationExportEntries(bundleData({ settings: null }));
		const settings = entries.find((e) => e.path === "01-settings.csv")!;
		expect(settings.content).toBe("字段,值\r\n（无）\r\n");
		expect(buildOrganizationReadme(bundleData({ settings: null }))).not.toContain(
			"undefined",
		);
	});
});

describe("export-builder 有数据导出（组织账本）", () => {
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
		dataRequests: [requestRow()],
	});

	it("买入表：JPY 金额 0 位小数、未知费用「未知」、跨表编号可互查", () => {
		const entries = buildOrganizationExportEntries(data);
		const tx = entries.find((e) => e.path === "04-transactions.csv")!;
		expect(tx.content).toContain("tx-1");
		expect(tx.content).toContain("100000"); // JPY 0 位
		expect(tx.content).toContain("未知"); // feeAmount=null
		expect(tx.content).toContain("plan-9"); // 跨表编号
		expect(tx.content).toContain("720.00"); // USD 2 位
		expect(tx.content).toContain("0.00"); // fee=0 显示 0
	});

	it("计划表：金额带币种精度、名称逗号被转义", () => {
		const entries = buildOrganizationExportEntries(data);
		const plans = entries.find((e) => e.path === "06-plans.csv")!;
		expect(plans.content).toContain('"日本之行, 秋季"');
		expect(plans.content).toContain("100000");
	});

	it("使用记录表附使用成本列（本位币口径）", () => {
		const entries = buildOrganizationExportEntries(data);
		const usage = entries.find((e) => e.path === "08-usage-records.csv")!;
		expect(usage.content).toContain("使用成本(CNY)");
		expect(usage.content).toContain("1500.25");
		expect(usage.content).toContain("plan-9");
	});

	it("数据请求表含导出记录自身与数据域", () => {
		const entries = buildOrganizationExportEntries(data);
		const dr = entries.find((e) => e.path === "11-data-requests.csv")!;
		expect(dr.content).toContain("dr-1");
		expect(dr.content).toContain("组织,EXPORT,COMPLETED");
	});

	it("settings 表导出组织偏好（不含个人展示偏好语言/地区）", () => {
		const entries = buildOrganizationExportEntries(data);
		const settings = entries.find((e) => e.path === "01-settings.csv")!;
		expect(settings.content).toContain("CNY");
		expect(settings.content).toContain("2026-06-01T08:30:00.000Z");
		expect(settings.content).not.toContain("语言");
		expect(settings.content).not.toContain("地区");
	});

	it("组织信息表与组织名转义", () => {
		const entries = buildOrganizationExportEntries(
			bundleData({ organization: { id: "org-9", name: "Acme, 东京", createdAt: T0 } }),
		);
		expect(entries.find((e) => e.path === "10-organization.csv")!.content).toBe(
			`组织编号,组织名称,创建时间\r\norg-9,"Acme, 东京",${formatDateTime(T0)}\r\n`,
		);
	});
});

describe("export-builder 个人数据导出（DATA-01：零组织财务明细）", () => {
	function personalData(
		patch: Partial<PersonalExportBundleData> = {},
	): PersonalExportBundleData {
		return {
			generatedAt: T0,
			profile: { id: "user-1", email: "kyle@example.com", name: "Kyle", createdAt: T0 },
			preferences: { locale: "zh-CN", region: "CN" },
			organizations: [
				{
					organizationId: "org-1",
					organizationName: "Acme 工作台",
					role: "ADMIN",
					status: "ACTIVE",
					joinedAt: T0,
				},
			],
			conversations: [
				{ id: "conv-1", title: "换汇计划怎么排", createdAt: T0, lastMessageAt: T0 },
			],
			termsConsents: [
				{ id: "tc-1", termsVersion: "v1", consentType: "TERMS", consentedAt: T0 },
			],
			dataRequests: [requestRow({ scope: "PERSONAL" })],
			...patch,
		};
	}

	it("条目集合恰为个人域 7 项，与账本明细条目零交集", () => {
		const entries = buildPersonalExportEntries(personalData());
		expect(entries.map((entry) => entry.path)).toEqual([...PERSONAL_EXPORT_PATHS]);
		for (const ledgerPath of ORGANIZATION_LEDGER_PATHS) {
			expect(entries.some((entry) => entry.path === ledgerPath), ledgerPath).toBe(false);
		}
		// 两个入口的条目集合互不交叉（README 除外：两个包各自带一份阅读说明）
		const orgPaths = buildOrganizationExportEntries(bundleData()).map((entry) => entry.path);
		const overlap = orgPaths.filter(
			(path) => path !== "README.txt" && (PERSONAL_EXPORT_PATHS as readonly string[]).includes(path),
		);
		expect(overlap).toEqual([]);
	});

	it("内容逐表断言：账号资料/偏好/组织摘要/会话元数据/条款/个人请求", () => {
		const byPath = new Map(
			buildPersonalExportEntries(personalData()).map((e) => [e.path, e.content]),
		);
		expect(byPath.get("01-profile.csv")).toBe(
			`用户编号,邮箱,姓名,注册时间\r\nuser-1,kyle@example.com,Kyle,${formatDateTime(T0)}\r\n`,
		);
		expect(byPath.get("02-preferences.csv")).toBe("语言,地区\r\nzh-CN,CN\r\n");
		expect(byPath.get("03-organizations.csv")).toBe(
			`组织编号,组织名称,角色,成员状态,加入时间\r\norg-1,Acme 工作台,ADMIN,ACTIVE,${formatDateTime(T0)}\r\n`,
		);
		expect(byPath.get("04-conversations.csv")).toBe(
			`会话编号,标题,创建时间,最后消息时间\r\nconv-1,换汇计划怎么排,${formatDateTime(T0)},${formatDateTime(T0)}\r\n`,
		);
		expect(byPath.get("05-terms-consents.csv")).toContain("tc-1,v1,TERMS,");
		expect(byPath.get("06-data-requests.csv")).toContain("dr-1,个人,EXPORT,COMPLETED");
	});

	it("个人包全文不含账本表头与金额字段（隔离：交易/持仓/批次/计划/使用/更正）", () => {
		const entries = buildPersonalExportEntries(personalData());
		const text = entries.map((entry) => entry.content).join("\n");
		for (const forbidden of [
			"分配金额",
			"已使用",
			"使用成本",
			"余额",
			"本金",
			"手续费",
			"目标金额",
			"变更前快照",
		]) {
			expect(text.includes(forbidden), forbidden).toBe(false);
		}
	});

	it("无个人设置行 / 无组织 / 无会话时输出「（无）」注记，不虚构数据", () => {
		const byPath = new Map(
			buildPersonalExportEntries(
				personalData({
					preferences: null,
					organizations: [],
					conversations: [],
				}),
			).map((e) => [e.path, e.content]),
		);
		expect(byPath.get("02-preferences.csv")).toBe("语言,地区\r\n（无）\r\n");
		expect(byPath.get("03-organizations.csv")).toContain("（无）");
		expect(byPath.get("04-conversations.csv")).toContain("（无）");
	});

	it("README 声明不含组织账本明细并指向组织导出", () => {
		const readme = buildPersonalReadme(personalData());
		expect(readme).toContain("FXPlanner 个人数据导出包");
		expect(readme).toContain("2026-06-01T08:30:00.000Z");
		expect(readme).toContain("组织数据导出");
		expect(readme).toContain("不含消息正文");
		expect(readme).not.toContain("undefined");
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

	it("两个归档入口产出的 ZIP 条目与各自条目构建器一致（读回逐项核对）", async () => {
		const JSZip = (await import("jszip")).default;
		const personal = {
			generatedAt: T0,
			profile: { id: "user-1", email: null, name: null, createdAt: T0 },
			preferences: null,
			organizations: [],
			conversations: [],
			termsConsents: [],
			dataRequests: [],
		} satisfies PersonalExportBundleData;
		const organization = bundleData();

		const personalZip = await JSZip.loadAsync(await buildPersonalExportArchive(personal));
		const organizationZip = await JSZip.loadAsync(await buildOrganizationExportArchive(organization));

		expect(Object.keys(personalZip.files).sort()).toEqual(
			[...PERSONAL_EXPORT_PATHS].sort(),
		);
		expect(Object.keys(organizationZip.files).sort()).toEqual(
			buildOrganizationExportEntries(organization).map((entry) => entry.path).sort(),
		);
		// 个人 ZIP 内没有任何账本明细条目
		for (const ledgerPath of ORGANIZATION_LEDGER_PATHS) {
			expect(personalZip.files[ledgerPath], ledgerPath).toBeUndefined();
		}
		expect(await personalZip.files["README.txt"].async("string")).toBe(
			buildPersonalReadme(personal),
		);
	});
});
