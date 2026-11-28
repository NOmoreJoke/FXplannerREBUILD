import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	runCheckComplianceCopy,
	scanPaths,
	scanSourceText,
	stripCommentsPreservingPositions,
} from "../check-compliance-copy";

const REPO_ROOT = resolve(import.meta.dir, "../..");

describe("check-compliance-copy", () => {
	test("正向全仓扫描通过（0 违规且覆盖超过 100 个源码文件）", () => {
		const summary = scanPaths(REPO_ROOT);
		expect(summary.filesScanned).toBeGreaterThan(100);
		expect(summary.violations).toEqual([]);
	});

	test("负向拦截四大类合规封杀词并准确定位行列号", () => {
		const sample = [
			'const a = "稳赚产品收益高";',
			'const b = "预测明天看涨";',
			'const c = "现在抄底是最佳时机，建议买入并择时";',
			'const d = "灵积总控派单给记账专员";',
		].join("\n");

		const violations = scanSourceText(
			sample,
			"clients/chat-web/components/business/sample.tsx",
		);
		expect(violations.map((v) => `${v.line}:${v.category}:${v.term}`)).toEqual([
			"1:INVESTMENT_PROMISE:稳赚",
			"1:INVESTMENT_PROMISE:赚",
			"1:INVESTMENT_PROMISE:收益",
			"2:MARKET_PREDICTION:预测",
			"2:MARKET_PREDICTION:看涨",
			"3:TIMING_INDUCEMENT:抄底",
			"3:TIMING_INDUCEMENT:最佳时机",
			"3:TIMING_INDUCEMENT:建议买入",
			"3:TIMING_INDUCEMENT:择时",
			"4:LEGACY_BRAND_OR_BUREAUCRACY:灵积",
			"4:LEGACY_BRAND_OR_BUREAUCRACY:总控",
			"4:LEGACY_BRAND_OR_BUREAUCRACY:记账专员",
		]);
	});

	test("防话术洗白：免责句式仅剥离自身，同行其余违规词仍被拦截", () => {
		const tricky = 'const msg = "本工具不构成投资建议，但建议买入稳赚";';
		const violations = scanSourceText(
			tricky,
			"clients/chat-web/app/page.tsx",
		);
		expect(violations.map((v) => v.term)).toEqual(["建议买入", "稳赚", "赚"]);
	});

	test("URL 中的 https:// 不误判为注释且同行后续违规词仍被拦截", () => {
		const line = 'const link = "https://fxplanner.app"; const tip = "现在抄底";';
		const stripped = stripCommentsPreservingPositions(line);
		expect(stripped).toBe(line);

		const violations = scanSourceText(
			line,
			"clients/chat-web/components/business/link.tsx",
		);
		expect(violations.map((v) => v.term)).toEqual(["抄底"]);
	});

	test("正则字面量内的 //、/* 与字符集 [`] 不破坏注释状态机，JSX 标签不误判为正则", () => {
		const code = [
			'const re1 = /^https?:\\/\\//; const bad1 = "现在抄底";',
			'const re2 = /\\/\\*/; const bad2 = "稳赚";',
			'const re3 = /[`]/; const bad3 = "审查员";',
			'const tpl = `${/}/.test(s)} 最佳时机`;',
			'const jsx = <div>a / b</div>; const ok = <span />; // 预测',
		].join("\n");

		const violations = scanSourceText(
			code,
			"clients/chat-web/components/business/regex-sample.tsx",
		);
		expect(violations.map((v) => `${v.line}:${v.term}`)).toEqual([
			"1:抄底",
			"2:稳赚",
			"2:赚",
			"3:审查员",
			"4:最佳时机",
		]);
	});

	test("防过宽白名单：收益比较高与选择时机均仍被拦截", () => {
		const sample = [
			'const a = "这个方案保证收益比较高";',
			'const b = "建议自主选择时机买入";',
		].join("\n");

		const violations = scanSourceText(
			sample,
			"clients/chat-web/components/business/narrow.tsx",
		);
		expect(violations.map((v) => `${v.line}:${v.term}`)).toEqual([
			"1:收益",
			"2:择时",
		]);
	});

	test("合法白名单、源码注释与行内 compliance-allow 注释均放行", () => {
		const clean = [
			'export const DISCLAIMER = "本工具由非持牌主体提供，非投资顾问服务；汇率与计划均为工具测算，不构成投资建议、不预测涨跌、不经手资金；据此操作的风险与损失由用户自行承担。";',
			'export const REPORT_A = "不计算收益比较";',
			'export const REPORT_B = "收益比较将在后续版本提供";',
			'export const SELECT_TIP = "modelKey 已选择时进 body；未选择时不进 body";',
			"// 注释里的 预测 涨跌 抄底 稳赚 不应报警",
			"/* 多行注释里的 最佳时机 灵积 总控 */",
			"{/* JSX 注释里的 记账专员 建议买入 */}",
			'const allowByHuman = "收益比较占位"; // compliance-allow: 人工复核占位',
		].join("\n");

		expect(
			scanSourceText(clean, "clients/chat-web/components/base/sample.tsx"),
		).toEqual([]);
	});

	test("字符串字面量伪造 compliance-allow 不能绕过扫描", () => {
		const forged = 'const fake = "现在抄底稳赚 compliance-allow";';
		const violations = scanSourceText(
			forged,
			"clients/chat-web/app/page.tsx",
		);
		expect(violations.map((v) => v.term)).toEqual(["抄底", "稳赚", "赚"]);
	});

	test("CLI --stdin 返回码正/负双证", () => {
		const badCode = runCheckComplianceCopy(
			["--stdin", "--stdin-filename", "clients/chat-web/app/page.tsx"],
			'export const BAD = "现在抄底稳赚，最佳时机建议买入";\n',
			REPO_ROOT,
		);
		expect(badCode).toBe(1);

		const goodCode = runCheckComplianceCopy(
			["--stdin", "--stdin-filename", "clients/chat-web/app/page.tsx"],
			'export const OK = "本工具不构成投资建议、不预测涨跌";\n',
			REPO_ROOT,
		);
		expect(goodCode).toBe(0);
	});
});
