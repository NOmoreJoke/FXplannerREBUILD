import { describe, expect, it } from "vitest";
import {
	COMPLIANCE_BANNED_TERMS,
	COMPLIANCE_BANNED_WORDS,
	COMPLIANCE_INLINE_ALLOW_MARKER,
	maskAllowedComplianceContexts,
	scanTextForComplianceViolations,
} from "./compliance-lexicon";

describe("compliance-lexicon", () => {
	it("词表无重复且覆盖四大类封杀词", () => {
		const uniqueTerms = new Set(COMPLIANCE_BANNED_WORDS);
		expect(uniqueTerms.size).toBe(COMPLIANCE_BANNED_TERMS.length);

		const categories = new Set(COMPLIANCE_BANNED_TERMS.map((t) => t.category));
		expect(categories).toEqual(
			new Set([
				"INVESTMENT_PROMISE",
				"MARKET_PREDICTION",
				"TIMING_INDUCEMENT",
				"LEGACY_BRAND_OR_BUREAUCRACY",
			]),
		);
	});

	it("法定免责声明与报告合法占位语境零误报", () => {
		const disclaimer =
			"本工具由非持牌主体提供，非投资顾问服务；汇率与计划均为工具测算，不构成投资建议、不预测涨跌、不经手资金；据此操作的风险与损失由用户自行承担。";
		expect(scanTextForComplianceViolations(disclaimer)).toEqual([]);

		expect(
			scanTextForComplianceViolations(
				"纯初始持仓显示「不计算收益比较」，含买入显示「收益比较将在后续版本提供」。",
			),
		).toEqual([]);
	});

	it("剥离白名单保持原字符串长度且防整行洗白与拼接造词", () => {
		const mixed = "本工具不构成投资建议，但建议买入稳赚";
		const masked = maskAllowedComplianceContexts(mixed);
		expect(masked.length).toBe(mixed.length);

		const hits = scanTextForComplianceViolations(mixed);
		expect(hits.map((h) => h.term)).toEqual(["建议买入", "稳赚", "赚"]);
		expect(hits[0]?.column).toBe(mixed.indexOf("建议买入") + 1);
	});

	it("精确区分「已选择时/未选择时」与「择时」，且拦截「选择时机」", () => {
		expect(
			scanTextForComplianceViolations("modelKey 已选择时进 body；未选择时不进 body"),
		).toEqual([]);
		expect(
			scanTextForComplianceViolations("模型建议用户做汇率择时").map((h) => h.term),
		).toEqual(["择时"]);
		expect(
			scanTextForComplianceViolations("建议自主选择时机买入").map((h) => h.term),
		).toEqual(["择时"]);
	});

	it("不放行裸「收益比较」与新增禁止「审查员」称谓", () => {
		expect(
			scanTextForComplianceViolations("这个方案保证收益比较高").map((h) => h.term),
		).toEqual(["收益"]);
		expect(
			scanTextForComplianceViolations("已由审查员核对完毕").map((h) => h.term),
		).toEqual(["审查员"]);
	});

	it("运行时校验绝不识别 compliance-allow 豁免标记", () => {
		const modelOutput = `建议现在买入稳赚 // ${COMPLIANCE_INLINE_ALLOW_MARKER}`;
		const hits = scanTextForComplianceViolations(modelOutput);
		expect(hits.map((h) => h.term)).toEqual([
			"建议现在买入",
			"稳赚",
			"赚",
		]);
	});
});
