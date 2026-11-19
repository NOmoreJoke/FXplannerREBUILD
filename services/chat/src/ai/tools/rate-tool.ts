import { tool } from "@langchain/core/tools";
import type { HttpException } from "@nestjs/common";
import { z } from "zod";
import {
	isSupportedCurrency,
	REFERENCE_RATE_SOURCE,
	SUPPORTED_CURRENCIES,
	VALID_PERIODS,
} from "../../rate/rate.constants";
import {
	RatePairUnsupportedException,
	RateSourceUnavailableException,
} from "../../rate/rate.errors";
import type { RateService } from "../../rate/rate.service";

/**
 * ReAct agent 唯一工具（ai-assistant 技术方案 §3.1 tools/rate-tool.ts）：
 * query_exchange_rate，mode 分支映射 RateService.getLatest / getHistory。
 *
 * 错误纪律：入参非法 / 400 / 422 / 502 / 无历史积累一律转结构化错误文本回喂
 * （模型据此换参数重查一次或向用户解释），不抛出中断对话；空历史序列返回
 * 「暂无历史数据」文本，模型如实告知（13/15 币对无历史回源能力，§3.1 历史约束）。
 */
export const RATE_TOOL_NAME = "query_exchange_rate";

const SUPPORTED_LIST_TEXT = SUPPORTED_CURRENCIES.join("、");

const formatToolError = (code: string, message: string): string =>
	JSON.stringify({ error: code, message });

function toToolErrorText(error: unknown): string {
	if (error instanceof RatePairUnsupportedException) {
		return formatToolError(
			"RATE_PAIR_UNSUPPORTED",
			"该币对数据源不支持查询，请向用户说明可查询范围",
		);
	}
	if (error instanceof RateSourceUnavailableException) {
		return formatToolError(
			"RATE_SOURCE_UNAVAILABLE",
			"汇率数据源暂时不可用，请如实告知用户稍后再试",
		);
	}
	const response = (error as HttpException | null)?.getResponse?.();
	if (typeof response === "object" && response !== null && "code" in response) {
		return formatToolError(
			String(response.code),
			"查询失败，请向用户说明数据暂时不可得",
		);
	}
	return formatToolError(
		"RATE_SOURCE_UNAVAILABLE",
		"汇率数据源暂时不可用，请如实告知用户稍后再试",
	);
}

const formatLatestQuote = (item: {
	target: string;
	rate: string;
	observedAt: string;
}): string => `${item.target} = ${item.rate}（数据时间 ${item.observedAt}）`;

export function createRateTool(rateService: RateService) {
	return tool(
		async (input) => {
			const base = input.base.trim().toUpperCase();
			if (!isSupportedCurrency(base)) {
				return formatToolError(
					"RATE_PAIR_UNSUPPORTED",
					`不支持的基准币种 ${base}，可查询币种：${SUPPORTED_LIST_TEXT}`,
				);
			}

			if (input.mode === "latest") {
				const targets = (input.targets ?? [])
					.map((code) => code.trim().toUpperCase())
					.filter((code) => code.length > 0);
				if (targets.length < 1 || targets.length > 5) {
					return formatToolError(
						"INVALID_PARAMS",
						"latest 模式必须提供 1~5 个目标币种（targets）",
					);
				}
				const unsupported = targets.find((code) => !isSupportedCurrency(code));
				if (unsupported) {
					return formatToolError(
						"RATE_PAIR_UNSUPPORTED",
						`不支持的目标币种 ${unsupported}，可查询币种：${SUPPORTED_LIST_TEXT}`,
					);
				}
				try {
					const result = await rateService.getLatest(base, targets);
					// RateService 单/多目标返回形态经 satisfies 推断后无法直接辨识，防御式展开
					const items =
						"items" in result && Array.isArray(result.items)
							? result.items
							: [];
					if (items.length > 0) {
						const lines = items.map((item) =>
							"rate" in item
								? formatLatestQuote(item)
								: `${item.target} 查询失败：${item.error.message}`,
						);
						return `${base} 最新汇率：\n${lines.join("\n")}`;
					}
					const single = result as {
						target?: string;
						rate?: string;
						observedAt?: string;
					};
					if (
						single.target !== undefined &&
						single.rate !== undefined &&
						single.observedAt !== undefined
					) {
						return `${base} 最新汇率：${formatLatestQuote({
							target: single.target,
							rate: single.rate,
							observedAt: single.observedAt,
						})}`;
					}
					return formatToolError(
						"RATE_SOURCE_UNAVAILABLE",
						"汇率数据返回为空，请如实告知用户稍后再试",
					);
				} catch (error) {
					return toToolErrorText(error);
				}
			}

			// ── history 模式 ──
			const target = (input.target ?? "").trim().toUpperCase();
			if (target.length === 0) {
				return formatToolError(
					"INVALID_PARAMS",
					"history 模式必须提供目标币种（target）",
				);
			}
			if (!isSupportedCurrency(target)) {
				return formatToolError(
					"RATE_PAIR_UNSUPPORTED",
					`不支持的目标币种 ${target}，可查询币种：${SUPPORTED_LIST_TEXT}`,
				);
			}
			const period = input.period ?? 30;
			if (!(VALID_PERIODS as readonly number[]).includes(period)) {
				return formatToolError(
					"INVALID_PARAMS",
					`period 仅支持 ${VALID_PERIODS.join("、")} 天`,
				);
			}
			try {
				const history = await rateService.getHistory(base, target, period);
				const points = history.data_points ?? [];
				if (points.length === 0) {
					return `${base}/${target} 暂无历史数据，请如实告知用户该币对历史数据尚在积累中，禁止编造走势。`;
				}
				const rates = points.map((point) => Number(point.rate));
				const first = points[0];
				const last = points[points.length - 1];
				// 来源区分（MVP-F0-2 C2）：参考价（frankfurter v2 参考序列）与原来源报价
				// 必须在输出中显式区分，不得混为同源走势（realtime-rate 底稿 §2）
				const referenceCount = points.filter(
					(point) => point.source === REFERENCE_RATE_SOURCE,
				).length;
				const referenceNote =
					referenceCount > 0
						? `其中 ${referenceCount} 个数据点为参考价（frankfurter v2 参考序列，非原来源报价）`
						: "";
				return `${base}/${target} 近 ${period} 天历史走势（${points.length} 个数据点${referenceNote ? `，${referenceNote}` : ""}）：起点 ${first.date} = ${first.rate}，终点 ${last.date} = ${last.rate}，区间最高 ${Math.max(...rates)}，区间最低 ${Math.min(...rates)}。回答时请注明数据时间范围${referenceNote ? "，并区分参考价与原来源报价" : ""}。`;
			} catch (error) {
				return toToolErrorText(error);
			}
		},
		{
			name: RATE_TOOL_NAME,
			description:
				"查询 FXPlanner 汇率数据。mode=latest 查最新汇率（可一次传 1~5 个目标币种 targets）；mode=history 查历史区间走势（需 target 与 period，仅支持 7/30/90 天）。",
			schema: z.object({
				mode: z
					.enum(["latest", "history"])
					.describe("查询模式：latest 最新价 / history 历史区间"),
				base: z.string().describe("基准币种的 3 字母代码，如 USD、CNY"),
				targets: z
					.array(z.string())
					.optional()
					.describe(
						'latest 模式：目标币种代码列表（1~5 个），如 ["CNY","JPY"]',
					),
				target: z.string().optional().describe("history 模式：目标币种代码"),
				// 类型级校验（int）；7/30/90 的值域约束在函数体内校验——越界值走
				// 结构化错误文本回喂（模型自纠），而非 zod parse 异常中断（§3.1 错误纪律）
				period: z
					.number()
					.int()
					.optional()
					.describe("history 模式：区间天数，仅支持 7、30、90"),
			}),
		},
	);
}
