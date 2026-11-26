/**
 * 报告模块 E2E 造数 helper（changes/reports/技术方案.md §10.4）。
 *
 * M7 使用记录已上线（POST /plans/:id/usages 五步事务含 FIFO 分摊落库），
 * 造数全部走真实后端 API（与 api-seeder 同风格、与 UI 解耦）：
 * 录入买入（可含未知手续费）→ 建计划分配 → 记录使用（写侧自动分摊）→
 * 完成/取消计划 → 报告读侧即可见分摊事实。
 *
 * 「M7 未上线时 E2E 阶段 4 执行」的前提已解除：造数不直连数据库。
 * 唯一例外是 seedInitialHoldings 的取价兜底（外呼汇率不可用时经 rate-cache-db 向本地测试库
 * 插一条测试汇率缓存行，重试后立即按 id 清理）——Prisma 连接与库校验都在该 helper 内。
 */

import { api } from "./api-seeder";
import {
	injectFreshRateCacheRows,
	removeRateCacheRows,
} from "./rate-cache-db";

/**
 * 带退避重试的造数请求：dev 后端刚就绪/并行脚本重启窗口期偶发 fetch failed
 * （E2E 运行实证），对网络层错误重试 3 次（2s 退避）；业务错误（4xx success=false）不重试。
 */
async function apiWithRetry<T>(
	path: string,
	init: { method: string; token?: string; body?: unknown },
	attempts = 3,
): Promise<T> {
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await api<T>(path, init);
		} catch (error) {
			lastError = error;
			const message = error instanceof Error ? error.message : String(error);
			// 仅网络层失败重试；业务错误（「API 造数失败 ... 400 ...」）直接抛出
			if (!message.includes("TypeError") && !message.includes("fetch failed")) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
	}
	throw lastError;
}

/** 当前时刻（ISO）：使用/买入日期不早于记账起点（注册当日）且不晚于今天 */
function nowIso(): string {
	return new Date().toISOString();
}

/** 创建换汇计划（POST /api/plans；targetAmount/allocatedAmount 均可指定，服务端重算排期） */
export async function seedPlan(
	token: string,
	options: {
		targetCurrency: string;
		targetAmount: string;
		allocatedAmount: string;
	},
): Promise<string> {
	const data = await apiWithRetry<{ id: string }>("/api/plans", {
		method: "POST",
		token,
		body: {
			targetCurrency: options.targetCurrency,
			targetAmount: options.targetAmount,
			expectUseDate: "2030-02-15T00:00:00.000Z",
			prepLeadDays: 3,
			pacePreference: "balanced",
			startDate: "2030-01-01T00:00:00.000Z",
			allocatedAmount: options.allocatedAmount,
		},
	});
	return data.id;
}

/** 录入一笔买入（汇率 1：本金 = 到账数量）；fee 传 null/undefined = 手续费未明确 */
export async function seedPurchase(
	token: string,
	currencyCode: string,
	quantity: string,
	fee?: string | null,
): Promise<string> {
	const data = await apiWithRetry<{ id: string }>("/api/transactions", {
		method: "POST",
		token,
		body: {
			currencyCode,
			principalAmount: quantity,
			exchangeRate: "1",
			quantity,
			...(fee === undefined || fee === null ? {} : { feeAmount: fee }),
			transactedAt: nowIso(),
		},
	});
	return data.id;
}

/** 记录一笔使用（M7 五步事务：扣分配/扣余额/FIFO 分摊/写分摊明细/递减批次） */
export async function seedUsage(
	token: string,
	planId: string,
	amount: string,
): Promise<string> {
	const data = await apiWithRetry<{ usage: { id: string } }>(
		`/api/plans/${planId}/usages`,
		{
			method: "POST",
			token,
			body: { amount, usedAt: nowIso() },
		},
	);
	return data.usage.id;
}

/** 完成确认（POST /plans/:id/complete；要求已使用 = 目标且剩余分配 = 0） */
export async function seedCompletePlan(
	token: string,
	planId: string,
): Promise<void> {
	await apiWithRetry(`/api/plans/${planId}/complete`, {
		method: "POST",
		token,
	});
}

/** 调低目标（PATCH /plans/:id，乐观锁取详情 updatedAt；用于使用后对齐目标以满足完成校验） */
export async function seedAdjustTarget(
	token: string,
	planId: string,
	newTargetAmount: string,
): Promise<void> {
	const detail = await apiWithRetry<{ updatedAt: string }>(
		`/api/plans/${planId}`,
		{ method: "GET", token },
	);
	await apiWithRetry(`/api/plans/${planId}`, {
		method: "PATCH",
		token,
		body: {
			newTargetAmount,
			expectedUpdatedAt: detail.updatedAt,
		},
	});
}

/** 取消计划（POST /plans/:id/cancel，终态；释放剩余分配） */
export async function seedCancelPlan(
	token: string,
	planId: string,
): Promise<void> {
	await apiWithRetry(`/api/plans/${planId}/cancel`, { method: "POST", token });
}

/** POST /api/onboarding/initial-holdings（带网络层重试；业务错误原样抛出） */
function postInitialHoldings(
	token: string,
	holdings: { currencyCode: string; amount: string }[],
): Promise<unknown> {
	return apiWithRetry("/api/onboarding/initial-holdings", {
		method: "POST",
		token,
		body: { holdings },
	});
}

/** 是否为取价失败（400 RATE_UNAVAILABLE；api() 把响应码拼进错误消息） */
function isRateUnavailable(error: unknown): boolean {
	return (
		error instanceof Error && /\bRATE_UNAVAILABLE\b/.test(error.message)
	);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 补录初始持仓（POST /api/onboarding/initial-holdings；初始批次按记账起点汇率入账）。
 *
 * 取价兜底：该接口入账取价会外呼实时汇率，本机代理 / TUN 不稳定时报 400 RATE_UNAVAILABLE。
 * 本函数在 beforeAll 造数链上，一旦失败会拖垮整个 describe（含不依赖初始持仓的用例），
 * 所以仅当首提返回 RATE_UNAVAILABLE 时兜底一次：向本地测试库为各外币种插入一条新鲜的
 * frankfurter 汇率缓存行（rate-cache-db；后端入账取价命中新鲜缓存后不再外呼），重试一次；
 * 重试返回后立即按 id 清理，合成报价不会留给后续入账取价。其他错误不兜底、原样抛出。
 *
 * baseCurrency 须与该用户建账时的本位币一致（缓存行方向：base = 本位币、quote = 外币）。
 */
export async function seedInitialHoldings(
	token: string,
	holdings: { currencyCode: string; amount: string }[],
	baseCurrency = "CNY",
): Promise<void> {
	let rateError: unknown;
	try {
		await postInitialHoldings(token, holdings);
		return;
	} catch (error) {
		if (!isRateUnavailable(error)) throw error;
		rateError = error;
	}

	let injected: Awaited<ReturnType<typeof injectFreshRateCacheRows>>;
	try {
		injected = await injectFreshRateCacheRows(
			baseCurrency,
			holdings.map((holding) => holding.currencyCode),
		);
	} catch (injectionError) {
		throw new Error(
			`补录初始持仓取价失败（${describeError(rateError)}），且汇率缓存兜底未能写入本地测试库` +
				`（${describeError(injectionError)}）。请检查本机代理 / TUN 是否稳定，以及 ` +
				"services/chat/.env.local 的 DATABASE_URL 是否指向回环主机上的本地测试库。",
		);
	}
	try {
		await postInitialHoldings(token, holdings);
	} finally {
		await removeRateCacheRows(injected.map((row) => row.id));
	}
}
