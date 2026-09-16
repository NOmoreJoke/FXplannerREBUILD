"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import {
	ratesApi,
	type LatestRateGroupResponse,
	type LatestRateItem,
	type LatestRateResponse,
} from "@/lib/api/rates";

/** live 模式轮询周期（§3.5：走后端 5 分钟窗口缓存，命中不外呼） */
const POLL_INTERVAL_MS = 60_000;

/** locked 模式过期翻转的时钟推进步长（1s 心跳） */
const CLOCK_TICK_MS = 1_000;

/** 查询 Key 词根（[domain, action] 约定；完整 Key 由 buildLatestRatesQueryKey 组装） */
export const LATEST_RATES_QUERY_STEM = ["rates", "latest"] as const;

/** 组装完整查询 Key（§4.2：base + targets 串 + locked/live 模式位） */
export function buildLatestRatesQueryKey(
	base: string,
	targetsKey: string,
	locked: boolean,
): readonly unknown[] {
	return [
		...LATEST_RATES_QUERY_STEM,
		base,
		targetsKey,
		locked ? "locked" : "live",
	];
}

/** hook 错误形态（§4.2：ApiError 归一结果；lastObservedAt 供「最后报价时间与原因」展示） */
export interface LatestRatesError {
	code: string;
	message: string;
	lastObservedAt: string | null;
}

export interface UseLatestRatesParams {
	base: string;
	targets: string[];
	/** 确认页锁定模式：停轮询，数字固定（§3.5 Locked 态） */
	locked?: boolean;
}

export interface LatestRatesResult {
	/** 报价项数组（单目标响应归一化为单元素；项级 error 原样保留供 UI 判定） */
	rates: LatestRateItem[] | null;
	/** 组内最早 validUntil <= now 即过期（恰好等于视为过期，§4.1）；纯前端计算 */
	isExpired: boolean;
	/** 首次请求进行中 */
	isLoading: boolean;
	error: LatestRatesError | null;
	/** 一次性强制重查（refresh=true 绕过后端窗口）；打开页面/过期重试/确认前由消费方触发 */
	refreshLatest: () => Promise<void>;
}

/**
 * 单目标平铺响应 → 单元素 items 数组；多目标响应原样返回 items。
 * 导出纯函数供消费方与测试复用（单/多目标两种响应形状归一）。
 */
export function normalizeLatestRates(
	response: LatestRateResponse | LatestRateGroupResponse,
): LatestRateItem[] {
	if ("items" in response) {
		return response.items;
	}
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

/**
 * 录入价取法（§4.1）：银行现汇卖出价优先，非银行源缺省回退基准价；
 * 项级错误（rate/sellRate 均缺省）返回 undefined，由消费方按 error 呈现。
 */
export function resolveEntryRate(item: LatestRateItem): string | undefined {
	return item.sellRate ?? item.rate;
}

/** ApiError/未知错误 → hook 错误形态（502 响应体的 lastObservedAt 从 body 透传） */
function toLatestRatesError(error: unknown): LatestRatesError {
	if (error instanceof ApiError) {
		const lastObservedAt = error.body?.lastObservedAt;
		return {
			code: error.code ?? "UNKNOWN",
			message: error.message,
			lastObservedAt:
				typeof lastObservedAt === "string" ? lastObservedAt : null,
		};
	}
	return {
		code: "UNKNOWN",
		message: error instanceof Error ? error.message : "最新汇率查询失败",
		lastObservedAt: null,
	};
}

/**
 * 最新报价消费层（changes/realtime-rate/技术方案.md §3.5 能力规格，消费层唯一入口）。
 *
 * 单数据通道设计：挂载后/queryKey 变化后的首次拉取带 refresh=true（进入页面
 * 强制回源），之后的 60s 轮询与焦点重取走 refresh=false（后端窗口缓存）；
 * refreshLatest 置强制标记后 refetch，对 locked（enabled:false）查询同样生效
 * （react-query 手动 refetch 不受 enabled 限制），确认页「先取数后锁数」即此路径。
 *
 * hook 不持有任何表单状态（§3.5 防覆盖手填）；报价新鲜度由 validUntil 元数据
 * 表达，所有查询显式 staleTime: 0（不依赖 react-query 的 stale 语义）。
 */
export function useLatestRates(
	params: UseLatestRatesParams,
): LatestRatesResult {
	const { base, targets, locked = false } = params;
	const targetsKey = targets.join(",");

	// 强制回源标记：refreshLatest 置位，由下一次 queryFn 消费（置位与消费同处
	// 一个同步任务，轮询/焦点重取无法插队）；queryFn 内的标记自复位。
	const forcedRef = useRef(true);
	// 上次 fetch 服务的 Key 标识：Key 变化（换币种/locked↔live）后的首次拉取强制回源
	const keyRef = useRef<string | null>(null);
	const keyId = buildLatestRatesQueryKey(base, targetsKey, locked).join(
		"\u0000",
	);

	const query = useQuery({
		queryKey: buildLatestRatesQueryKey(base, targetsKey, locked),
		queryFn: () => {
			const forced = forcedRef.current || keyRef.current !== keyId;
			forcedRef.current = false;
			keyRef.current = keyId;
			return ratesApi.latest(base, targets, forced);
		},
		enabled: !locked, // locked：停轮询，仅手动 refreshLatest 取数（数字固定）
		staleTime: 0, // 显式置 0：新鲜度由 fresh/validUntil 表达，不被全局 5min 吞掉
		retry: false, // 服务层不自动重试（§6），重试交给 60s 轮询/用户手动触发
		refetchInterval: locked ? false : POLL_INTERVAL_MS,
		refetchIntervalInBackground: false, // 切后台暂停轮询
		refetchOnWindowFocus: locked ? false : true, // 核对页回前台不自动换数（doc 02）
	});

	/** 一次性强制重查：置位后 refetch（结果写入同一 Key，locked 下亦可取数） */
	const refreshLatest = async (): Promise<void> => {
		forcedRef.current = true;
		await query.refetch();
	};

	const rates = useMemo(
		() => (query.data ? normalizeLatestRates(query.data) : null),
		[query.data],
	);

	// 组内最早 validUntil（无有效时间的项——如项级错误——不参与判定）
	const earliestValidUntilMs = useMemo(() => {
		if (!rates) return null;
		const times = rates
			.map((item) =>
				item.validUntil ? Date.parse(item.validUntil) : Number.NaN,
			)
			.filter((time) => !Number.isNaN(time));
		return times.length > 0 ? Math.min(...times) : null;
	}, [rates]);

	// locked 停轮询后数据静止，用 1s 心跳推进内部 now 让 isExpired 随时间翻转
	// （倒计时归零场景）；live 模式由轮询/焦点驱动重渲染，无需常驻心跳。
	const [lockedNow, setLockedNow] = useState(() => Date.now());
	const hasQuote = earliestValidUntilMs !== null;
	useEffect(() => {
		if (!locked || !hasQuote) {
			return;
		}
		const timer = setInterval(() => setLockedNow(Date.now()), CLOCK_TICK_MS);
		return () => clearInterval(timer);
	}, [locked, hasQuote]);

	const nowMs = locked ? lockedNow : Date.now();
	const isExpired =
		earliestValidUntilMs !== null && earliestValidUntilMs <= nowMs;

	return {
		rates,
		isExpired,
		isLoading: query.isLoading,
		error: query.error ? toLatestRatesError(query.error) : null,
		refreshLatest,
	};
}
