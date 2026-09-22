"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { finalAmountOf, getCurrency, roundRateTo8 } from "@fxplanner-new/money";
import { ratesApi, type LatestRateItem } from "@/lib/api/rates";

/** 防抖时长（金额行停止变化后再取价，避免逐键请求） */
export const REVIEW_DEBOUNCE_MS = 600;

/** 核对区单行输入：已通过行校验的有效行（币种已选、金额合法） */
export interface ReviewInputRow {
	currencyCode: string;
	amount: string;
}

/** 核对区单行结果（取价成功后按当时快照计算） */
export interface ReviewRowData {
	target: string;
	amount: string;
	/** 采用价（sellRate ?? rate）四舍五入到 8 位后的展示值 */
	rateDisplay: string;
	/** 报价来源展示文案 */
	source: string;
	/** 报价时间（observedAt 日期部分） */
	observedDate: string;
	/** 预计初始成本（本位币）；RoundToZero 等计算失败时为 null */
	costDisplay: string | null;
	costError?: string;
}

export type ReviewState =
	| { status: "idle"; rows: [] }
	| { status: "loading"; rows: [] }
	| { status: "error"; rows: [] }
	| { status: "success"; rows: ReviewRowData[] };

/** 单/多目标响应归一为 items（多目标为向导核对区唯一实际形态，平铺分支防御性保留） */
function normalizeItems(
	response: Awaited<ReturnType<typeof ratesApi.latest>>,
): LatestRateItem[] {
	if ("items" in response) return response.items;
	return [
		{
			target: response.target,
			rate: response.rate,
			...(response.sellRate !== undefined
				? { sellRate: response.sellRate }
				: {}),
			source: response.source,
			observedAt: response.observedAt,
			validUntil: response.validUntil,
			fresh: response.fresh,
		},
	];
}

/** 报价来源展示文案（对齐 rate-reference-card：abc 源标注现汇卖出价） */
function resolveSourceLabel(source: string): string {
	return source === "abc" ? "农行牌价 · 现汇卖出价" : source;
}

/**
 * 向导核对区取价状态机（建账向导第二步 / 补录共用，规格模块 2/3）。
 *
 * 输入为本位币与「已通过行校验的有效行」；内部完成防抖取价、过期响应
 * 丢弃与成本计算。与后端入账口径对齐（logic-audit N1）：
 * - 成本按【本位币】精度舍入一次（HALF_UP，money 包 finalAmountOf），
 *   与 onboarding.service 入账一致——绝不用持仓币种精度；
 * - 录入价口径同 rate-reference-card 先例：sellRate ?? rate =「1 外币 = X 本位币」。
 *
 * 取价频率（logic-audit N2 + changes/rate-stale-echo-fix）：金额变化不影响汇率；
 * 首次取价与仅金额变化走 refresh=false（后端窗口缓存回显已落库报价，超窗由
 * 后端陈旧回显 + 后台刷新，进页不再必等外呼）；仅「非首次的币种集合变化」
 * 置 refresh=true 强制回源，避免逐次外呼放大外部汇率源压力。
 */
export function useHoldingsReview(
	baseCurrency: string,
	rows: ReviewInputRow[],
): ReviewState {
	const [review, setReview] = useState<ReviewState>({
		status: "idle",
		rows: [],
	});

	// 取价请求序号：仅最新一次请求的响应可落地（防过期响应覆盖新输入）
	const seqRef = useRef(0);

	// 输入防御（契约：有效行不应含空币种/本位币；直调时兜底排除）
	const safeRows = useMemo(
		() =>
			rows.filter(
				(row) => row.currencyCode !== "" && row.currencyCode !== baseCurrency,
			),
		[rows, baseCurrency],
	);

	// 币种集合签名（本位币 + 有效行币种，不含金额）：refresh 决策依据
	const codesSignature = useMemo(
		() =>
			JSON.stringify([baseCurrency, safeRows.map((row) => row.currencyCode)]),
		[baseCurrency, safeRows],
	);
	const prevCodesSignatureRef = useRef<string | null>(null);

	// 本位币精度缓存：成本舍入口径与持仓币种无关（N1），整批一次计算
	const baseDecimalPlaces = getCurrency(baseCurrency)?.decimalPlaces ?? 2;

	useEffect(() => {
		const codes = safeRows.map((row) => row.currencyCode);
		if (codes.length === 0) {
			setReview({ status: "idle", rows: [] });
			return;
		}
		// 输入变化即先置 loading（旧核对结果立即失效），防抖后取价
		setReview({ status: "loading", rows: [] });

		const timer = setTimeout(() => {
			const seq = ++seqRef.current;
			// 在真正发出请求时才推进签名：effect 若在防抖窗口内被 cleanup
			//（快速连续输入 / StrictMode 双挂载），不应把「换币种」标记消费掉；
			// 首次（prev 为 null）不强制——回显已落库报价，不等外呼（SWR）
			const shouldRefresh =
				prevCodesSignatureRef.current !== null &&
				prevCodesSignatureRef.current !== codesSignature;
			prevCodesSignatureRef.current = codesSignature;
			void (async () => {
				try {
					const response = await ratesApi.latest(
						baseCurrency,
						codes,
						shouldRefresh,
					);
					if (seq !== seqRef.current) return;
					const items = normalizeItems(response);
					// 项级 error（含报价数据缺失）：整体视为失败，绝不用 0 或手填价
					const byTarget = new Map(items.map((item) => [item.target, item]));
					const failed = codes.some((code) => {
						const item = byTarget.get(code);
						return !item || item.error !== undefined;
					});
					if (failed) {
						setReview({ status: "error", rows: [] });
						return;
					}
					const nextRows: ReviewRowData[] = safeRows.map((row) => {
						// failed 已排除缺项，此处必有数据
						// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
						const item = byTarget.get(row.currencyCode)!;
						// 录入价口径（rate-reference-card 先例）：sellRate ?? rate =「1 外币 = X 本位币」
						const adoptedRate = roundRateTo8(item.sellRate ?? item.rate ?? 0);
						let costDisplay: string | null = null;
						let costError: string | undefined;
						try {
							// N1：按本位币精度舍入一次，与后端入账（onboarding.service）一致
							costDisplay = finalAmountOf(
								row.amount,
								adoptedRate,
								baseDecimalPlaces,
							).toFixed(baseDecimalPlaces);
						} catch {
							// 正数成本被舍入为 0（RoundToZeroError）：拦截展示，不得入账
							costError = "金额过小，折算成本舍入为 0，无法入账";
						}
						return {
							target: row.currencyCode,
							amount: row.amount,
							rateDisplay: adoptedRate.toFixed(8),
							source: resolveSourceLabel(item.source ?? ""),
							observedDate: (item.observedAt ?? "").slice(0, 10) || "—",
							costDisplay,
							costError,
						};
					});
					setReview({ status: "success", rows: nextRows });
				} catch {
					if (seq !== seqRef.current) return;
					setReview({ status: "error", rows: [] });
				}
			})();
		}, REVIEW_DEBOUNCE_MS);
		return () => clearTimeout(timer);
		// rows 金额变化也需重算（复用缓存报价），故依赖完整 rows；
		// codesSignature 仅用于 refresh 决策
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [baseCurrency, codesSignature, rows, safeRows]);

	return review;
}
