import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
	invalidateAfterDataRequestMutation,
	invalidateAfterLedgerMutation,
	invalidateAfterOnboarding,
	queryKeys,
	withOrgScope,
} from "./query-keys";

describe("queryKeys factory & invalidators", () => {
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

	it("invalidateAfterOnboarding 覆盖 onboarding/home/settings/reminders/accounts 联动缓存", () => {
		const qc = new QueryClient();
		const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();

		invalidateAfterOnboarding(qc);

		expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([
			["onboarding", "status"],
			["home", "state"],
			["home", "portfolio"],
			["settings"],
			["reminders", "list"],
			["accounts"],
		]);
	});

	it("invalidateAfterLedgerMutation 与 invalidateAfterDataRequestMutation 精准覆盖全部关联域", () => {
		const qc = new QueryClient();
		const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();

		invalidateAfterLedgerMutation(qc, { planId: "p-1" });
		expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([
			["accounts"],
			["plans"],
			["usages"],
			["plans", "detail", "p-1"],
			["usages", "list", "p-1"],
			["reports"],
			["home", "state"],
			["home", "portfolio"],
			["reminders", "list"],
		]);

		spy.mockClear();
		invalidateAfterDataRequestMutation(qc);
		expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([
			["data-request"],
		]);
	});
});
