import { describe, expect, test } from "bun:test";
import {
	evaluateObservePolicy,
	mergeChangedMaps,
	normalizeDirArg,
	parseCliArgs,
	parseGitDiffNameStatus,
	parseGitPorcelainStatus,
	resolveDiffBaseCandidates,
	shouldFailOnMissingDiffBase,
	summarizeObserveResults,
	type EslintFileResult,
} from "../lint-observe";

describe("lint-observe helpers", () => {
	test("parseCliArgs extracts --dir and optional --base", () => {
		expect(parseCliArgs(["--dir", "services/chat"])).toEqual({
			dir: "services/chat",
			base: undefined,
		});
		expect(
			parseCliArgs(["--dir=clients/chat-web", "--base", "origin/dev"]),
		).toEqual({
			dir: "clients/chat-web",
			base: "origin/dev",
		});
		expect(() => parseCliArgs([])).toThrow();
	});

	test("summarizeObserveResults aggregates baseline errors, warnings, and top rules", () => {
		const results: EslintFileResult[] = [
			{
				filePath: "/repo/services/chat/src/a.ts",
				errorCount: 1,
				warningCount: 2,
				messages: [
					{
						ruleId: "@typescript-eslint/no-unused-vars",
						severity: 2,
						message: "unused",
						line: 1,
						column: 1,
					},
					{
						ruleId: "@typescript-eslint/no-non-null-assertion",
						severity: 1,
						message: "non-null",
						line: 2,
						column: 1,
					},
					{
						ruleId: "@typescript-eslint/no-non-null-assertion",
						severity: 1,
						message: "non-null",
						line: 3,
						column: 1,
					},
				],
			},
			{
				filePath: "/repo/services/chat/src/b.ts",
				errorCount: 0,
				warningCount: 0,
				messages: [],
			},
		];

		expect(summarizeObserveResults(results)).toEqual({
			filesScanned: 2,
			totalErrors: 1,
			totalWarnings: 2,
			topRules: [
				{ ruleId: "@typescript-eslint/no-non-null-assertion", count: 2 },
				{ ruleId: "@typescript-eslint/no-unused-vars", count: 1 },
			],
		});
	});

	test("parseGitDiffNameStatus handles A/M/R/D and filters by dir and TS extensions", () => {
		const stdout = [
			"A\tclients/chat-web/lib/api/query-keys.ts",
			"M\tclients/chat-web/lib/api/client.ts",
			"R095\tclients/chat-web/old.ts\tclients/chat-web/new.tsx",
			"M\tclients/chat-web/README.md",
			"A\tservices/chat/src/foo.ts",
		].join("\n");

		const parsed = parseGitDiffNameStatus(stdout, "clients/chat-web");
		expect(parsed.get("clients/chat-web/lib/api/query-keys.ts")).toBe("added");
		expect(parsed.get("clients/chat-web/lib/api/client.ts")).toBe("modified");
		expect(parsed.get("clients/chat-web/new.tsx")).toBe("modified");
		expect(parsed.has("clients/chat-web/README.md")).toBe(false);
		expect(parsed.has("services/chat/src/foo.ts")).toBe(false);
	});

	test("parseGitPorcelainStatus preserves leading spaces and detects untracked/added/modified", () => {
		const stdout = [
			" M clients/chat-web/lib/api/chat.ts",
			"?? clients/chat-web/lib/new-hook.ts",
			"A  clients/chat-web/lib/staged-new.tsx",
			"R  clients/chat-web/a.ts -> clients/chat-web/b.ts",
			" D clients/chat-web/deleted.ts",
		].join("\n");

		const parsed = parseGitPorcelainStatus(stdout, "clients/chat-web");
		expect(parsed.get("clients/chat-web/lib/api/chat.ts")).toBe("modified");
		expect(parsed.get("clients/chat-web/lib/new-hook.ts")).toBe("added");
		expect(parsed.get("clients/chat-web/lib/staged-new.tsx")).toBe("added");
		expect(parsed.get("clients/chat-web/b.ts")).toBe("modified");
		expect(parsed.has("clients/chat-web/deleted.ts")).toBe(false);
	});

	test("mergeChangedMaps keeps added classification when branch-added file is edited in working tree", () => {
		const committed = new Map<string, "added" | "modified">([
			["services/chat/src/new.ts", "added"],
		]);
		const wt = new Map<string, "added" | "modified">([
			["services/chat/src/new.ts", "modified"],
		]);
		expect(mergeChangedMaps(committed, wt).get("services/chat-web/x")).toBeUndefined();
		expect(mergeChangedMaps(committed, wt).get("services/chat/src/new.ts")).toBe("added");
	});

	test("evaluateObservePolicy ignores untouched legacy files, allows warnings on modified files, blocks warnings on added files", () => {
		const repoRoot = "/repo";
		const results: EslintFileResult[] = [
			{
				filePath: "/repo/services/chat/src/untouched.ts",
				errorCount: 5,
				warningCount: 3,
				messages: [],
			},
			{
				filePath: "/repo/services/chat/src/modified-warn-only.ts",
				errorCount: 0,
				warningCount: 2,
				messages: [],
			},
			{
				filePath: "/repo/services/chat/src/modified-with-err.ts",
				errorCount: 1,
				warningCount: 0,
				messages: [
					{
						ruleId: "@typescript-eslint/no-unused-vars",
						severity: 2,
						message: "err",
						line: 10,
						column: 3,
					},
				],
			},
			{
				filePath: "/repo/services/chat/src/added-with-warn.ts",
				errorCount: 0,
				warningCount: 1,
				messages: [
					{
						ruleId: "@typescript-eslint/no-explicit-any",
						severity: 1,
						message: "warn",
						line: 4,
						column: 7,
					},
				],
			},
			{
				filePath: "/repo/services/chat/src/added-clean.ts",
				errorCount: 0,
				warningCount: 0,
				messages: [],
			},
		];

		const changed = new Map<string, "added" | "modified">([
			["services/chat/src/modified-warn-only.ts", "modified"],
			["services/chat/src/modified-with-err.ts", "modified"],
			["services/chat/src/added-with-warn.ts", "added"],
			["services/chat/src/added-clean.ts", "added"],
		]);

		const violations = evaluateObservePolicy(results, changed, repoRoot);
		expect(violations.map((v) => v.relPath)).toEqual([
			"services/chat/src/modified-with-err.ts",
			"services/chat/src/added-with-warn.ts",
		]);
	});

	test("normalizeDirArg, resolveDiffBaseCandidates, and shouldFailOnMissingDiffBase enforce fail-closed CI / explicit --base", () => {
		expect(normalizeDirArg("./services/chat/")).toBe("services/chat");
		expect(
			parseGitDiffNameStatus(
				"M\tservices/chat/src/a.ts",
				"./services/chat/",
			).get("services/chat/src/a.ts"),
		).toBe("modified");

		expect(resolveDiffBaseCandidates("origin/main", { GITHUB_BASE_REF: "dev" })).toEqual([
			"origin/main",
		]);
		expect(resolveDiffBaseCandidates(undefined, { GITHUB_BASE_REF: "main" })).toEqual([
			"main",
			"origin/main",
			"dev",
			"origin/dev",
		]);
		expect(resolveDiffBaseCandidates(undefined, { GITHUB_BASE_REF: "dev" })).toEqual([
			"dev",
			"origin/dev",
		]);

		expect(shouldFailOnMissingDiffBase("nonexistent-ref", {})).toBe(true);
		expect(shouldFailOnMissingDiffBase(undefined, { CI: "true" })).toBe(true);
		expect(shouldFailOnMissingDiffBase(undefined, { GITHUB_ACTIONS: "true" })).toBe(true);
		expect(shouldFailOnMissingDiffBase(undefined, {})).toBe(false);
	});
});
