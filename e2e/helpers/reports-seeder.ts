/**
 * 报告模块 E2E 造数 helper（changes/reports/技术方案.md §10.4）。
 *
 * M7 使用记录已上线（POST /plans/:id/usages 五步事务含 FIFO 分摊落库），
 * 造数全部走真实后端 API（与 api-seeder 同风格、与 UI 解耦）：
 * 录入买入（可含未知手续费）→ 建计划分配 → 记录使用（写侧自动分摊）→
 * 完成/取消计划 → 报告读侧即可见分摊事实。
 *
 * 「M7 未上线时 E2E 阶段 4 执行」的前提已解除：本文件不直连数据库。
 */

import { api } from "./api-seeder";

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

/** 补录初始持仓（POST /api/onboarding/initial-holdings；初始批次按记账起点汇率入账） */
export async function seedInitialHoldings(
	token: string,
	holdings: { currencyCode: string; amount: string }[],
): Promise<void> {
	await apiWithRetry("/api/onboarding/initial-holdings", {
		method: "POST",
		token,
		body: { holdings },
	});
}
