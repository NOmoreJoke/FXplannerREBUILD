/**
 * 同源合规封杀词库与纯函数校验器（Stage 0c / W39）。
 *
 * 唯一真源：同时供静态 CI 门禁（scripts/check-compliance-copy.ts）与
 * 后端知禾 Agent 运行时规则校验层消费，杜绝前后端/静态与运行时词表漂移。
 */

export type ComplianceTermCategory =
	| "INVESTMENT_PROMISE"
	| "MARKET_PREDICTION"
	| "TIMING_INDUCEMENT"
	| "LEGACY_BRAND_OR_BUREAUCRACY";

export interface ComplianceBannedTerm {
	readonly term: string;
	readonly category: ComplianceTermCategory;
	readonly reason: string;
}

export interface ComplianceViolationMatch {
	readonly term: string;
	readonly category: ComplianceTermCategory;
	readonly reason: string;
	/** 1-based 列号 */
	readonly column: number;
}

/** 仅用于源码静态扫描人工复核行内豁免；运行时模型输出校验禁止识别该标记 */
export const COMPLIANCE_INLINE_ALLOW_MARKER = "compliance-allow" as const;

export const COMPLIANCE_BANNED_TERMS: readonly ComplianceBannedTerm[] = [
	// 1. 收益承诺与持牌投顾包装
	{
		term: "收益",
		category: "INVESTMENT_PROMISE",
		reason: "禁止使用收益承诺或理财收益表述，须使用成本/费用核算口径",
	},
	{
		term: "盈利",
		category: "INVESTMENT_PROMISE",
		reason: "禁止使用盈利表述，本工具仅做外币支出成本记录与测算",
	},
	{
		term: "赚",
		category: "INVESTMENT_PROMISE",
		reason: "禁止使用盈利/赚钱诱导表述",
	},
	{
		term: "稳赚",
		category: "INVESTMENT_PROMISE",
		reason: "禁止承诺确定性收益",
	},
	{
		term: "保本",
		category: "INVESTMENT_PROMISE",
		reason: "禁止使用保本承诺表述",
	},
	{
		term: "保证节省",
		category: "INVESTMENT_PROMISE",
		reason: "禁止承诺保证节省金额",
	},
	{
		term: "确定收益",
		category: "INVESTMENT_PROMISE",
		reason: "禁止承诺确定收益",
	},
	{
		term: "投资建议",
		category: "INVESTMENT_PROMISE",
		reason: "禁止提供投资建议或以投顾身份发言（仅免责声明否定句式豁免）",
	},
	{
		term: "金融投顾",
		category: "INVESTMENT_PROMISE",
		reason: "禁止以金融投顾自称或包装",
	},
	{
		term: "外汇咨询",
		category: "INVESTMENT_PROMISE",
		reason: "禁止使用外汇咨询等持牌业务包装词",
	},

	// 2. 涨跌预测
	{
		term: "预测",
		category: "MARKET_PREDICTION",
		reason: "禁止预测未来汇率走势（仅否定声明「不预测…」豁免）",
	},
	{
		term: "看涨",
		category: "MARKET_PREDICTION",
		reason: "禁止给出看涨方向判断",
	},
	{
		term: "看跌",
		category: "MARKET_PREDICTION",
		reason: "禁止给出看跌方向判断",
	},
	{
		term: "必涨",
		category: "MARKET_PREDICTION",
		reason: "禁止断言汇率必涨",
	},
	{
		term: "必跌",
		category: "MARKET_PREDICTION",
		reason: "禁止断言汇率必跌",
	},

	// 3. 择时诱导与买卖指令
	{
		term: "抄底",
		category: "TIMING_INDUCEMENT",
		reason: "禁止使用抄底等择时交易诱导词",
	},
	{
		term: "最佳时机",
		category: "TIMING_INDUCEMENT",
		reason: "禁止推荐所谓最佳换汇/买入时机",
	},
	{
		term: "最佳买入时机",
		category: "TIMING_INDUCEMENT",
		reason: "禁止推荐所谓最佳买入时机",
	},
	{
		term: "最佳换汇时机",
		category: "TIMING_INDUCEMENT",
		reason: "禁止推荐所谓最佳换汇时机",
	},
	{
		term: "择时",
		category: "TIMING_INDUCEMENT",
		reason: "禁止提供汇率择时建议（仅否定声明「不做/不建议/非择时」豁免）",
	},
	{
		term: "购汇相对有利",
		category: "TIMING_INDUCEMENT",
		reason: "禁止使用购汇相对有利等方向建议句式",
	},
	{
		term: "换汇相对有利",
		category: "TIMING_INDUCEMENT",
		reason: "禁止使用换汇相对有利等方向建议句式",
	},
	{
		term: "推迟购汇",
		category: "TIMING_INDUCEMENT",
		reason: "禁止建议推迟购汇",
	},
	{
		term: "推迟换汇",
		category: "TIMING_INDUCEMENT",
		reason: "禁止建议推迟换汇",
	},
	{
		term: "现在该换",
		category: "TIMING_INDUCEMENT",
		reason: "禁止给出现在该换的操作指令",
	},
	{
		term: "建议买入",
		category: "TIMING_INDUCEMENT",
		reason: "禁止给出建议买入的操作指令",
	},
	{
		term: "建议卖出",
		category: "TIMING_INDUCEMENT",
		reason: "禁止给出建议卖出的操作指令",
	},
	{
		term: "建议现在买入",
		category: "TIMING_INDUCEMENT",
		reason: "禁止给出建议现在买入的择时指令",
	},
	{
		term: "建议现在换汇",
		category: "TIMING_INDUCEMENT",
		reason: "禁止给出建议现在换汇的择时指令",
	},

	// 4. 历史脚手架残留词与后台官僚称谓（GWT-H1 / design-harness/intelligence/zhihe-persona.md）
	{
		term: "灵积",
		category: "LEGACY_BRAND_OR_BUREAUCRACY",
		reason: "禁止残留早期模板品牌词「灵积」，品牌名唯一为 FXPlanner",
	},
	{
		term: "总控",
		category: "LEGACY_BRAND_OR_BUREAUCRACY",
		reason: "禁止向用户暴露后台「总控」称谓，前台统一以知禾沟通",
	},
	{
		term: "记账专员",
		category: "LEGACY_BRAND_OR_BUREAUCRACY",
		reason: "禁止向用户暴露后台「记账专员」称谓",
	},
	{
		term: "规划专员",
		category: "LEGACY_BRAND_OR_BUREAUCRACY",
		reason: "禁止向用户暴露后台「规划专员」称谓",
	},
	{
		term: "审查员",
		category: "LEGACY_BRAND_OR_BUREAUCRACY",
		reason: "禁止向用户暴露后台「审查员」称谓，前台统一以知禾沟通",
	},
	{
		term: "圆桌派单",
		category: "LEGACY_BRAND_OR_BUREAUCRACY",
		reason: "禁止向用户暴露后台「圆桌派单」工程术语",
	},
];

export const COMPLIANCE_BANNED_WORDS: readonly string[] =
	COMPLIANCE_BANNED_TERMS.map((item) => item.term);

/**
 * 合法语境白名单短语：仅精确剥离白名单短语本身为等长空格，绝不整行豁免，
 * 防止「不构成投资建议，但建议买入稳赚」洗白绕过与删除拼接产生新词。
 */
export const COMPLIANCE_ALLOWED_CONTEXTS: readonly string[] = [
	// 法定免责与否定边界
	"不构成投资建议",
	"非投资建议",
	"不含投资建议",
	"不提供投资建议",
	"非投资顾问服务",
	"非投资顾问",
	"不预测涨跌",
	"不预测汇率方向",
	"不预测汇率",
	"不预测方向",
	"不建议择时",
	"不做择时",
	"非择时",
	// 报告法定占位区块术语（doc 12 / reports §5.2；不放行裸「收益比较」防运行时被拼接绕过）
	"收益比较将在后续版本提供",
	"不计算收益比较",
	"收益占位区块",
	"收益区块展示类型",
	"收益区块",
	"收益占位",
	// 语法同形非择时词（不放行裸「选择时」防屏蔽「选择时机」中的「择时」）
	"已选择时",
	"未选择时",
];

const SORTED_ALLOWED_CONTEXTS: readonly string[] = [
	...COMPLIANCE_ALLOWED_CONTEXTS,
].sort((a, b) => b.length - a.length);

/**
 * 将合法语境白名单短语替换为等长空格，保留原字符列号并防止左右拼接造词。
 */
export function maskAllowedComplianceContexts(text: string): string {
	let masked = text;
	for (const phrase of SORTED_ALLOWED_CONTEXTS) {
		if (!phrase || !masked.includes(phrase)) {
			continue;
		}
		const replacement = " ".repeat(phrase.length);
		masked = masked.split(phrase).join(replacement);
	}
	return masked;
}

/**
 * 扫描文本中的合规封杀词命中（仅剥离合法语境白名单；不识别 compliance-allow 源码注释标记）。
 */
export function scanTextForComplianceViolations(
	text: string,
): ComplianceViolationMatch[] {
	const masked = maskAllowedComplianceContexts(text);
	const matches: ComplianceViolationMatch[] = [];

	for (const entry of COMPLIANCE_BANNED_TERMS) {
		let searchFrom = 0;
		while (searchFrom < masked.length) {
			const idx = masked.indexOf(entry.term, searchFrom);
			if (idx === -1) {
				break;
			}
			matches.push({
				term: entry.term,
				category: entry.category,
				reason: entry.reason,
				column: idx + 1,
			});
			searchFrom = idx + entry.term.length;
		}
	}

	return matches.sort(
		(a, b) => a.column - b.column || b.term.length - a.term.length,
	);
}
