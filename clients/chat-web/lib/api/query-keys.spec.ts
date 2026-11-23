import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
	clearOrganizationScopedQueries,
	invalidateAfterDataRequestMutation,
	invalidateAfterLedgerMutation,
	invalidateAfterOnboarding,
	invalidateBusinessKey,
	isOrgScopedKey,
	matchesBusinessKey,
	queryKeys,
	withOrgScope,
} from "./query-keys";

type QueryKey = readonly unknown[];

/** 断言失效的辅助：预置数据 → 执行 → 检查 isInvalidated（行为级，不看调用形状） */
function seedAndRun(
	keys: QueryKey[],
	run: (qc: QueryClient) => void,
): QueryClient {
	const qc = new QueryClient();
	for (const key of keys) {
		qc.setQueryData(key, { v: 1 });
	}
	run(qc);
	return qc;
}

function isInvalidated(qc: QueryClient, key: QueryKey): boolean {
	return qc.getQueryState(key)?.isInvalidated === true;
}

describe("queryKeys factory", () => {
	it("全领域 key 与存量 tuple 契约保持一致", () => {
		expect(queryKeys.auth.me()).toEqual(["auth", "me"]);
		expect(queryKeys.onboarding.status()).toEqual(["onboarding", "status"]);
		expect(queryKeys.home.state()).toEqual(["home", "state"]);
		expect(queryKeys.home.portfolio()).toEqual(["home", "portfolio"]);
		expect(queryKeys.accounts.list()).toEqual(["accounts", "list"]);
		expect(queryKeys.accounts.detail("USD")).toEqual(["accounts", "detail", "USD"]);
		expect(queryKeys.accounts.ledger("USD")).toEqual(["accounts", "ledger", "USD"]);
		expect(queryKeys.accounts.allocations("USD")).toEqual([
			"accounts",
			"allocations",
			"USD",
		]);
		expect(queryKeys.plans.list()).toEqual(["plans", "list", "all"]);
		expect(queryKeys.plans.list("ACTIVE")).toEqual(["plans", "list", "ACTIVE"]);
		expect(queryKeys.plans.detail("plan-1")).toEqual(["plans", "detail", "plan-1"]);
		expect(queryKeys.transactions.detail("tx-1")).toEqual([
			"transactions",
			"detail",
			"tx-1",
		]);
		expect(queryKeys.usages.list("plan-1")).toEqual(["usages", "list", "plan-1"]);
		expect(queryKeys.corrections.list("USAGE", "u-1", 2)).toEqual([
			"corrections",
			"list",
			"USAGE",
			"u-1",
			2,
		]);
		expect(queryKeys.rates.supported()).toEqual(["rates", "supported"]);
		expect(queryKeys.rates.latestPair("CNY", "USD")).toEqual([
			"rates",
			"latest",
			"CNY",
			"USD",
		]);
		expect(queryKeys.rates.latestGroup("CNY", "USD,HKD", true)).toEqual([
			"rates",
			"latest",
			"CNY",
			"USD,HKD",
			"locked",
		]);
		expect(queryKeys.rates.history("CNY", "TWD", 30)).toEqual([
			"rates",
			"history",
			"CNY",
			"TWD",
			30,
		]);
		expect(queryKeys.reminders.list()).toEqual(["reminders", "list"]);
		expect(queryKeys.settings.detail()).toEqual(["settings"]);
		expect(queryKeys.reports.plans()).toEqual(["reports", "plans", "all", "all"]);
		expect(queryKeys.reports.plan("plan-1")).toEqual([
			"reports",
			"plan",
			"plan-1",
		]);
		expect(queryKeys.dataRequests.current()).toEqual(["data-request", "current"]);
		expect(queryKeys.dataRequests.impact()).toEqual(["data-request", "impact"]);
		expect(queryKeys.ai.conversations()).toEqual(["ai", "conversations"]);
		expect(queryKeys.ai.messages("conv-1")).toEqual(["ai", "messages", "conv-1"]);
		expect(queryKeys.ai.models()).toEqual(["ai", "models"]);
	});

	it("withOrgScope 缺省组织原样返回，传入 orgId 时追加组织前缀", () => {
		const key = queryKeys.plans.list("ACTIVE");
		expect(withOrgScope(undefined, key)).toBe(key);
		expect(withOrgScope(null, key)).toBe(key);
		expect(withOrgScope("org-42", key)).toEqual([
			"org",
			"org-42",
			"plans",
			"list",
			"ACTIVE",
		]);
	});
});

describe("组织感知失效：同时命中无前缀键与任意组织前缀键", () => {
	it("matchesBusinessKey：前缀语义与 invalidateQueries({ queryKey }) 一致", () => {
		// 无前缀键：自身 + 更长的键（前缀匹配）
		expect(matchesBusinessKey(["plans", "list", "all"], ["plans"])).toBe(true);
		expect(matchesBusinessKey(["plans"], ["plans"])).toBe(true);
		expect(matchesBusinessKey(["plans"], ["plans", "list"])).toBe(false);
		// 任意组织前缀下的同一业务键
		expect(
			matchesBusinessKey(["org", "org-a", "plans", "list", "all"], ["plans"]),
		).toBe(true);
		expect(
			matchesBusinessKey(["org", "org-b", "plans", "list", "ACTIVE"], ["plans", "list"]),
		).toBe(true);
		// 不同业务域 / 锚点后无组织 id / 业务键只出现在前缀之前
		expect(
			matchesBusinessKey(["org", "org-a", "accounts", "list"], ["plans"]),
		).toBe(false);
		expect(matchesBusinessKey(["org", "plans"], ["plans"])).toBe(false);
		expect(matchesBusinessKey(["organizations", "current", "org-a"], ["org"])).toBe(
			false,
		);
	});

	it("isOrgScopedKey：仅识别 [\"org\", <字符串 id>, …] 形态", () => {
		expect(isOrgScopedKey(["org", "org-a", "home", "state"])).toBe(true);
		expect(isOrgScopedKey(["org"])).toBe(false);
		expect(isOrgScopedKey(["org", 1, "home"])).toBe(false);
		expect(isOrgScopedKey(["home", "state"])).toBe(false);
		expect(isOrgScopedKey([])).toBe(false);
	});

	it("invalidateAfterLedgerMutation：账户/计划/使用/报告/首页/提醒的无前缀与 A、B 两组织前缀缓存全部失效", () => {
		const scoped = (orgId: string, key: QueryKey): QueryKey =>
			withOrgScope(orgId, key);
		const ledgerKeys: QueryKey[] = [
			queryKeys.accounts.list(),
			queryKeys.plans.list(),
			queryKeys.plans.detail("p-1"),
			queryKeys.usages.list("p-1"),
			queryKeys.reports.plans(),
			queryKeys.home.state(),
			queryKeys.home.portfolio(),
			queryKeys.reminders.list(),
		];
		const allForms = ledgerKeys.flatMap((key) => [
			key,
			scoped("org-a", key),
			scoped("org-b", key),
		]);
		const unrelated: QueryKey[] = [
			queryKeys.auth.me(),
			queryKeys.rates.supported(),
			queryKeys.organizations.list(),
			queryKeys.members.list(),
			queryKeys.ai.conversations(),
			queryKeys.ai.models(),
			queryKeys.onboarding.status(),
		];
		const qc = seedAndRun(
			[...allForms, ...unrelated],
			(client) => invalidateAfterLedgerMutation(client, { planId: "p-1" }),
		);
		for (const key of allForms) {
			expect(isInvalidated(qc, key), `应失效：${JSON.stringify(key)}`).toBe(true);
		}
		for (const key of unrelated) {
			expect(isInvalidated(qc, key), `不应失效：${JSON.stringify(key)}`).toBe(false);
		}
	});

	it("invalidateAfterOnboarding：首页/提醒/设置/账户/建账态的全形态失效", () => {
		const keys: QueryKey[] = [
			queryKeys.onboarding.status(),
			queryKeys.home.state(),
			queryKeys.home.portfolio(),
			queryKeys.settings.detail(),
			queryKeys.reminders.list(),
			queryKeys.accounts.list(),
		];
		const allForms = keys.flatMap((key) => [key, withOrgScope("org-a", key)]);
		const qc = seedAndRun(allForms, invalidateAfterOnboarding);
		for (const key of allForms) {
			expect(isInvalidated(qc, key), `应失效：${JSON.stringify(key)}`).toBe(true);
		}
	});

	it("invalidateAfterDataRequestMutation：数据请求域全形态失效", () => {
		const keys: QueryKey[] = [
			queryKeys.dataRequests.current(),
			queryKeys.dataRequests.impact(),
			withOrgScope("org-a", queryKeys.dataRequests.current()),
		];
		const qc = seedAndRun(keys, invalidateAfterDataRequestMutation);
		for (const key of keys) {
			expect(isInvalidated(qc, key)).toBe(true);
		}
	});

	it("invalidateBusinessKey 不依赖 queryKey 过滤（仅 predicate）——无前缀词根也能命中前缀键", () => {
		const qc = new QueryClient();
		const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
		invalidateBusinessKey(qc, queryKeys.plans.all);
		expect(spy).toHaveBeenCalledTimes(1);
		// 回归要点：此前传 { queryKey: ["plans"] }，前缀匹配命中不了 ["org", id, "plans", …]
		expect(spy.mock.calls[0]?.[0]?.queryKey).toBeUndefined();
		expect(typeof spy.mock.calls[0]?.[0]?.predicate).toBe("function");
	});
});

describe("ToB W20：组织作用域键与切换清理", () => {
	it("A/B 组织同业务键完全正交（前缀不同，永不碰撞）", () => {
		const a = withOrgScope("org-a", queryKeys.home.state());
		const b = withOrgScope("org-b", queryKeys.home.state());
		expect(a).toEqual(["org", "org-a", "home", "state"]);
		expect(b).toEqual(["org", "org-b", "home", "state"]);
		expect(a).not.toEqual(b);
		// 未选组织回落个人键（兼容窗口语义）
		expect(withOrgScope(null, queryKeys.home.state())).toEqual([
			"home",
			"state",
		]);
	});

	it("组织域键组齐备（organizations/members/invitations/auditLogs）", () => {
		expect(queryKeys.organizations.list()).toEqual([
			"organizations",
			"list",
		]);
		// 组织详情按组织 id 分桶（评审 I-18）：切换后不会读到上一个组织的 capabilities
		expect(queryKeys.organizations.current("org-a")).toEqual([
			"organizations",
			"current",
			"org-a",
		]);
		expect(queryKeys.organizations.current("org-b")).not.toEqual(
			queryKeys.organizations.current("org-a"),
		);
		expect(queryKeys.members.list()).toEqual(["members", "list"]);
		expect(queryKeys.invitations.list()).toEqual(["invitations", "list"]);
		expect(queryKeys.auditLogs.list()).toEqual(["audit-logs", "list"]);
	});

	it("clearOrganizationScopedQueries：移除组织作用域缓存（含任意组织前缀键、组织详情、建账态），保留公共缓存", () => {
		const qc = new QueryClient();
		const removed: QueryKey[] = [
			// 无前缀组织数据键
			queryKeys.home.state(),
			queryKeys.accounts.list(),
			queryKeys.members.list(),
			queryKeys.invitations.list(),
			queryKeys.auditLogs.list(),
			queryKeys.onboarding.status(),
			// 任意组织的带前缀键（旧组织数据不留存内存，切回时重新拉取）
			withOrgScope("org-a", queryKeys.home.state()),
			withOrgScope("org-z", queryKeys.plans.list()),
			withOrgScope("org-a", queryKeys.ai.messages("conv-1")),
			// 组织详情（任意组织的分桶键）
			queryKeys.organizations.current("org-a"),
		];
		const kept: QueryKey[] = [
			queryKeys.rates.supported(),
			queryKeys.auth.me(),
			queryKeys.organizations.list(),
			queryKeys.ai.models(),
		];
		for (const key of [...removed, ...kept]) {
			qc.setQueryData(key, { v: 1 });
		}

		clearOrganizationScopedQueries(qc);

		for (const key of removed) {
			expect(qc.getQueryData(key), `应移除：${JSON.stringify(key)}`).toBeUndefined();
		}
		for (const key of kept) {
			expect(qc.getQueryData(key), `应保留：${JSON.stringify(key)}`).toBeDefined();
		}
	});

	it("clearOrganizationScopedQueries：在途的组织数据请求被取消，公共请求不受影响", () => {
		const qc = new QueryClient();
		const cancelSpy = vi.spyOn(qc, "cancelQueries").mockResolvedValue();
		clearOrganizationScopedQueries(qc);
		expect(cancelSpy).toHaveBeenCalledTimes(1);
		const predicate = cancelSpy.mock.calls[0]?.[0]?.predicate;
		expect(typeof predicate).toBe("function");
		const matches = (key: QueryKey) =>
			// @ts-expect-error predicate 只读取 queryKey 字段
			predicate({ queryKey: key }) === true;
		expect(matches(withOrgScope("org-a", queryKeys.home.state()))).toBe(true);
		expect(matches(queryKeys.home.state())).toBe(true);
		expect(matches(queryKeys.organizations.current("org-a"))).toBe(true);
		expect(matches(queryKeys.rates.supported())).toBe(false);
		expect(matches(queryKeys.auth.me())).toBe(false);
		expect(matches(queryKeys.organizations.list())).toBe(false);
	});
});
