/**
 * 账户模块 E2E 造数 helper（changes/account-module/技术方案.md §5.3/§8.3）。
 *
 * 走真实后端 API 造数（注册/登录拿 token → 完成设置 → 录入买入 → 建计划分配），
 * 与 UI 解耦：场景数据前置构造，用例本体只做页面导航与断言。
 *
 * 初始化设置说明（方案 §8.3 场景 1 注）：onboarding 向导前端已取消，
 * 此处 POST consents + complete 仅用于构造 baseCurrency（成本列动态本位币依赖它）；
 * 真实新用户无 userSettings 的 baseCurrency=null 降级展示由接口测试 §8.2 覆盖。
 *
 * 后端地址：process.env.API_URL ?? http://localhost:4001（对齐 playwright.config 注释：
 * E2E 依赖人工预启动的前后端服务，本文件不拉起任何服务）。
 */

const API_URL = process.env.API_URL ?? "http://localhost:4001";

/** 连通性已检查（首次 api() 调用时探针一次，避免环境错配时逐用例报 fetch failed 噪声） */
let apiReachabilityChecked = false;

/** 首次造数前探针：后端不可达时直接给出可行动的诊断，而不是 N 条 fetch failed */
async function ensureApiReachable(): Promise<void> {
	if (apiReachabilityChecked) return;
	apiReachabilityChecked = true;
	try {
		const res = await fetch(`${API_URL}/api/health`, {
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
	} catch (error) {
		throw new Error(
			`后端不可达：${API_URL}/api/health 探针失败（${error instanceof Error ? error.message : error}）。` +
				`请确认服务已启动，且 API_URL/API_PORT 与实际端口一致（根 .env.local 的 API_PORT）。`,
		);
	}
}

/** auth Throttler 窗口 60s；触发 429 时等到窗口重置后重试（后端未注入 AUTH_THROTTLE_LIMIT 放大时的兑底） */
const THROTTLE_RETRY_DELAY_MS = 61_000;

/** 带退避的 fetch：429 等窗口重置重试一次；网络层失败给出可行动诊断 */
async function fetchWithBackoff(
	path: string,
	init: RequestInit,
): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(`${API_URL}${path}`, init);
	} catch (error) {
		throw new Error(
			`后端连接失败：${API_URL}${path}（${error instanceof Error ? error.message : error}）。` +
				`请检查后端是否存活、API_URL/API_PORT 是否与实际端口一致。`,
		);
	}
	if (res.status === 429) {
		console.warn(
			`⏳ [api-seeder] ${path} 触发 429 限流，等待 ${THROTTLE_RETRY_DELAY_MS / 1000}s 窗口重置后重试一次` +
				`（长期方案：后端以 AUTH_THROTTLE_LIMIT 放大启动，见 services/chat/.env.local.example）`,
		);
		await new Promise((resolve) =>
			setTimeout(resolve, THROTTLE_RETRY_DELAY_MS),
		);
		res = await fetch(`${API_URL}${path}`, init);
	}
	return res;
}

/** 前端登录态 cookie 名（与 clients/chat-web/lib/auth/token.ts 唯一事实来源一致） */
export const ACCESS_TOKEN_COOKIE = "accessToken";

import type { BrowserContext } from "@playwright/test";

interface ApiEnvelope<T> {
	success: boolean;
	data: T;
	message?: string;
}

/** 造数场景默认参数（数字全部可复算：两笔各 6,000 → 余额 12,000、分配 6,000、未分配 6,000） */
export interface AccountSeedOverrides {
	baseCurrency?: string;
	/** 两笔买入的目标币种 */
	currencyCode?: string;
	/** 单笔买入本金 = 到账数量（汇率 1） */
	amountPerTrade?: string;
	/** 计划分配金额 */
	allocatedAmount?: string;
	/** 是否跳过初始化设置（构造 baseCurrency=null 降级场景） */
	skipOnboarding?: boolean;
}

export interface AccountSeedResult {
	email: string;
	password: string;
	/** 访问令牌（同时已按登录态说明注入 cookie 使用） */
	accessToken: string;
	userId: string;
	/** 买入记录 id（按录入顺序） */
	transactionIds: string[];
}

/** 当前时刻（ISO）：新用户账本起点为注册当日，用「现在」既不早于起点也不晚于今天 */
function nowIso(): string {
	return new Date().toISOString();
}

/** 远期用途日与开始日（对齐 test/helpers/plan-test-helper.ts 的固定日期先例，不依赖真实时钟） */
const PLAN_EXPECT_USE_DATE = "2030-02-15T00:00:00.000Z";
const PLAN_START_DATE = "2030-01-01T00:00:00.000Z";

/** HTTP 请求封装（success 包装校验；报告等模块 seeder 复用；含探针与 429 退避） */
export async function api<T>(
	path: string,
	init: { method: string; token?: string; body?: unknown },
): Promise<T> {
	await ensureApiReachable();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (init.token) {
		headers.Authorization = `Bearer ${init.token}`;
	}
	const res = await fetchWithBackoff(path, {
		method: init.method,
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	const json = (await res.json()) as ApiEnvelope<T> & {
		code?: string;
		message?: string;
	};
	if (!res.ok || !json.success) {
		throw new Error(
			`API 造数失败 ${init.method} ${path} → ${res.status} ${json.code ?? ""} ${json.message ?? ""}`,
		);
	}
	return json.data;
}

/** 注册并登录测试用户（返回 token 与 userId；用后由后端测试/人工清理或级联复用） */
export async function seedRegisterAndLogin(label: string): Promise<{
	email: string;
	password: string;
	accessToken: string;
	userId: string;
}> {
	const email = `e2e-account-${label}-${Date.now()}@example.com`;
	const password = "TestPass123";
	await api("/api/auth/register", {
		method: "POST",
		body: { email, password, name: label },
	});
	const data = await api<{ accessToken: string; user: { id: string } }>(
		"/api/auth/login",
		{ method: "POST", body: { email, password } },
	);
	return {
		email,
		password,
		accessToken: data.accessToken,
		userId: data.user.id,
	};
}

/** 完成初始化设置（POST consents + complete）：仅用于构造 baseCurrency */
export async function seedOnboarding(
	token: string,
	baseCurrency = "CNY",
): Promise<void> {
	await api("/api/onboarding/consents", {
		method: "POST",
		token,
		body: { age18Confirmed: true, termsConfirmed: true },
	});
	await api("/api/onboarding/complete", {
		method: "POST",
		token,
		body: {
			baseCurrency,
			locale: "zh-CN",
			region: "CN",
			prepPreference: "balanced",
			reminderEnabled: true,
		},
	});
}

/** 录入一笔买入（汇率 1：本金 = 到账数量，fee=0），返回交易 id */
export async function seedTransaction(
	token: string,
	currencyCode: string,
	amount: string,
): Promise<string> {
	const data = await api<{ id: string }>("/api/transactions", {
		method: "POST",
		token,
		body: {
			currencyCode,
			principalAmount: amount,
			exchangeRate: "1",
			quantity: amount,
			feeAmount: "0",
			transactedAt: nowIso(),
		},
	});
	return data.id;
}

/** 创建换汇计划并附带分配（POST /api/plans，allocatedAmount 参与创建校验） */
export async function seedPlanWithAllocation(
	token: string,
	targetCurrency: string,
	allocatedAmount: string,
): Promise<string> {
	const data = await api<{ id: string }>("/api/plans", {
		method: "POST",
		token,
		body: {
			targetCurrency,
			targetAmount: "10000",
			expectUseDate: PLAN_EXPECT_USE_DATE,
			prepLeadDays: 3,
			pacePreference: "balanced",
			startDate: PLAN_START_DATE,
			allocatedAmount,
		},
	});
	return data.id;
}

/**
 * 账户列表/详情场景全套造数（方案 §8.3 场景 1/2 前置）：
 * 注册登录 → 完成设置（baseCurrency 默认 CNY）→ 录入 2 笔同币种买入 → 创建计划分配 6,000。
 * 默认账本：CAD 余额 12,000.0000 / 已分配 6,000.0000 / 未分配余额 6,000.0000 /
 * 平均单位成本 1.00000000（两笔 totalCost 6,000+6,000 ÷ 数量 12,000，接口字符串原样）。
 */
export async function seedAccountScenario(
	label: string,
	overrides: AccountSeedOverrides = {},
): Promise<AccountSeedResult> {
	const {
		baseCurrency = "CNY",
		currencyCode = "CAD",
		amountPerTrade = "6000",
		allocatedAmount = "6000",
		skipOnboarding = false,
	} = overrides;

	const user = await seedRegisterAndLogin(label);
	if (!skipOnboarding) {
		await seedOnboarding(user.accessToken, baseCurrency);
	}
	const transactionIds = [
		await seedTransaction(user.accessToken, currencyCode, amountPerTrade),
		await seedTransaction(user.accessToken, currencyCode, amountPerTrade),
	];
	await seedPlanWithAllocation(user.accessToken, currencyCode, allocatedAmount);

	return {
		email: user.email,
		password: user.password,
		accessToken: user.accessToken,
		userId: user.userId,
		transactionIds,
	};
}

/** 记录一笔使用（M7：POST /api/plans/:id/usages；汇率 1 造数下成本 = 金额），返回使用记录 */
export async function seedUsage(
	token: string,
	planId: string,
	amount: string,
): Promise<{ id: string; cost: string }> {
	const data = await api<{ id: string; cost: string }>(
		`/api/plans/${planId}/usages`,
		{
			method: "POST",
			token,
			body: { amount, usedAt: nowIso() },
		},
	);
	return data;
}

/** 将 accessToken 注入浏览器上下文（前端以 cookie 为唯一登录态事实来源） */
export async function injectLoginCookie(
	context: BrowserContext,
	token: string,
	url: string,
): Promise<void> {
	let baseUrl: URL;
	try {
		baseUrl = new URL(url);
	} catch {
		throw new Error(
			`injectLoginCookie 收到非法 URL：${url}（检查 CORS_ORIGIN / WEB_PORT 环境变量）`,
		);
	}
	await context.addCookies([
		{
			name: ACCESS_TOKEN_COOKIE,
			value: token,
			domain: baseUrl.hostname,
			path: "/",
			secure: baseUrl.protocol === "https:",
			httpOnly: false,
			sameSite: "Lax",
		},
	]);
}

// ---------------------------------------------------------------------------
// 提醒域造数（changes/reminders：M9 提醒与到期处理）
// ---------------------------------------------------------------------------

/** UTC+8 业务日「今天」的 0 点（UTC 标尺时刻；与后端 reminder-rules.utcPlus8Midnight 同口径） */
function bizTodayUtcStart(): Date {
	const shifted = new Date(Date.now() + 8 * 3_600_000);
	return new Date(
		Date.UTC(
			shifted.getUTCFullYear(),
			shifted.getUTCMonth(),
			shifted.getUTCDate(),
		),
	);
}

/** 业务今天（UTC+8）是否工作日（E2E 首批节点命中今天的前提；周末跳过用例） */
export function isBizTodayWorkday(): boolean {
	const day = bizTodayUtcStart().getUTCDay();
	return day !== 0 && day !== 6;
}

/** from（00:00Z）之后第 n 个工作日的 00:00Z */
function addWorkdaysUtc(from: Date, n: number): Date {
	const day = new Date(from);
	let left = n;
	while (left > 0) {
		day.setUTCDate(day.getUTCDate() + 1);
		if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) left--;
	}
	return day;
}

/**
 * 创建「首个准备节点命中业务今天」的计划（POST /api/plans，allocatedAmount=0 不占余额）：
 * startDate = 业务今天 → 服务端排期首批 = 今天 → 打开首页即触发 PREP_DUE 提醒。
 * 返回计划 id。
 */
export async function seedPlanDueToday(
	token: string,
	targetCurrency = "USD",
	targetAmount = "10000",
): Promise<string> {
	const today = bizTodayUtcStart();
	const data = await api<{ id: string }>("/api/plans", {
		method: "POST",
		token,
		body: {
			targetCurrency,
			targetAmount,
			expectUseDate: addWorkdaysUtc(today, 8).toISOString(),
			prepLeadDays: 3,
			pacePreference: "balanced",
			startDate: today.toISOString(),
			allocatedAmount: "0",
		},
	});
	return data.id;
}
