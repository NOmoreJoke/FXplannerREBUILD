import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ChangeKind = "added" | "modified";

export interface EslintLintMessage {
	ruleId: string | null;
	severity: 1 | 2;
	message: string;
	line: number;
	column: number;
}

export interface EslintFileResult {
	filePath: string;
	messages: EslintLintMessage[];
	errorCount: number;
	fatalErrorCount?: number;
	warningCount: number;
}

export interface ObserveSummary {
	filesScanned: number;
	totalErrors: number;
	totalWarnings: number;
	topRules: Array<{ ruleId: string; count: number }>;
}

export interface PolicyViolation {
	relPath: string;
	changeKind: ChangeKind;
	errorCount: number;
	warningCount: number;
	messages: EslintLintMessage[];
}

export interface CliOptions {
	dir: string;
	base?: string;
}

const TS_EXT_RE = /\.(ts|tsx|mts|cts)$/i;

export function parseCliArgs(argv: readonly string[]): CliOptions {
	let dir = "";
	let base: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--dir" && i + 1 < argv.length) {
			dir = argv[++i];
		} else if (token.startsWith("--dir=")) {
			dir = token.slice("--dir=".length);
		} else if (token === "--base" && i + 1 < argv.length) {
			base = argv[++i];
		} else if (token.startsWith("--base=")) {
			base = token.slice("--base=".length);
		}
	}

	if (!dir) {
		throw new Error("用法: bun run scripts/lint-observe.ts --dir <pkg-dir> [--base <ref>]");
	}
	return { dir, base };
}

export function normalizeRepoPath(repoRoot: string, absPath: string): string {
	return relative(repoRoot, absPath).replace(/\\/g, "/");
}

export function summarizeObserveResults(
	results: readonly EslintFileResult[],
): ObserveSummary {
	let totalErrors = 0;
	let totalWarnings = 0;
	const ruleCounts = new Map<string, number>();

	for (const file of results) {
		totalErrors += file.errorCount;
		totalWarnings += file.warningCount;
		for (const msg of file.messages) {
			const key = msg.ruleId ?? "fatal";
			ruleCounts.set(key, (ruleCounts.get(key) ?? 0) + 1);
		}
	}

	const topRules = [...ruleCounts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 8)
		.map(([ruleId, count]) => ({ ruleId, count }));

	return {
		filesScanned: results.length,
		totalErrors,
		totalWarnings,
		topRules,
	};
}

export function normalizeDirArg(dirArg: string): string {
	return dirArg.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function resolveDiffBaseCandidates(
	explicitBase?: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
	if (explicitBase) return [explicitBase];
	const candidates: string[] = [];
	const githubBase = env.GITHUB_BASE_REF?.trim();
	if (githubBase) {
		candidates.push(githubBase, `origin/${githubBase}`);
	}
	candidates.push("dev", "origin/dev");
	return [...new Set(candidates)];
}

export function shouldFailOnMissingDiffBase(
	explicitBase?: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	if (explicitBase) return true;
	return (
		env.CI === "true" ||
		env.CI === "1" ||
		env.GITHUB_ACTIONS === "true"
	);
}

export function parseGitDiffNameStatus(
	stdout: string,
	dirPrefix: string,
): Map<string, ChangeKind> {
	const result = new Map<string, ChangeKind>();
	const cleanDir = normalizeDirArg(dirPrefix);
	const normalizedPrefix = cleanDir ? `${cleanDir}/` : "";

	for (const rawLine of stdout.split(/\r?\n/)) {
		if (!rawLine) continue;
		const parts = rawLine.split("\t");
		if (parts.length < 2) continue;
		const statusCode = parts[0].trim();
		const targetPath = parts[parts.length - 1].replace(/\\/g, "/");
		if (!targetPath.startsWith(normalizedPrefix) || !TS_EXT_RE.test(targetPath)) {
			continue;
		}
		const kind: ChangeKind =
			statusCode.startsWith("A") || statusCode.startsWith("C")
				? "added"
				: "modified";
		result.set(targetPath, kind);
	}

	return result;
}

export function parseGitPorcelainStatus(
	stdout: string,
	dirPrefix: string,
): Map<string, ChangeKind> {
	const result = new Map<string, ChangeKind>();
	const cleanDir = normalizeDirArg(dirPrefix);
	const normalizedPrefix = cleanDir ? `${cleanDir}/` : "";

	for (const rawLine of stdout.split(/\r?\n/)) {
		if (rawLine.length < 4) continue;
		const xy = rawLine.slice(0, 2);
		let pathPart = rawLine.slice(3);
		const renameIdx = pathPart.indexOf(" -> ");
		if (renameIdx !== -1) {
			pathPart = pathPart.slice(renameIdx + 4);
		}
		pathPart = pathPart.replace(/\\/g, "/");
		if (!pathPart.startsWith(normalizedPrefix) || !TS_EXT_RE.test(pathPart)) {
			continue;
		}
		if (xy.includes("D")) continue;
		const kind: ChangeKind =
			xy === "??" || xy[0] === "A" || xy[1] === "A" ? "added" : "modified";
		result.set(pathPart, kind);
	}

	return result;
}

export function mergeChangedMaps(
	committed: ReadonlyMap<string, ChangeKind>,
	workingTree: ReadonlyMap<string, ChangeKind>,
): Map<string, ChangeKind> {
	const merged = new Map<string, ChangeKind>(committed);
	for (const [path, kind] of workingTree.entries()) {
		const existing = merged.get(path);
		// Files newly introduced on this branch stay "added" even after subsequent local edits
		if (existing === "added") {
			merged.set(path, "added");
		} else {
			merged.set(path, kind);
		}
	}
	return merged;
}

export function evaluateObservePolicy(
	results: readonly EslintFileResult[],
	changedFiles: ReadonlyMap<string, ChangeKind>,
	repoRoot: string,
): PolicyViolation[] {
	const violations: PolicyViolation[] = [];

	for (const file of results) {
		const relPath = normalizeRepoPath(repoRoot, file.filePath);
		const changeKind = changedFiles.get(relPath);
		if (!changeKind) continue;

		const fatalCount = file.fatalErrorCount ?? 0;
		const blocked =
			changeKind === "added"
				? file.errorCount > 0 || fatalCount > 0 || file.warningCount > 0
				: file.errorCount > 0 || fatalCount > 0;

		if (blocked) {
			violations.push({
				relPath,
				changeKind,
				errorCount: file.errorCount,
				warningCount: file.warningCount,
				messages: file.messages,
			});
		}
	}

	return violations;
}

function resolveDiffBase(repoRoot: string, explicitBase?: string): string | null {
	const candidates = resolveDiffBaseCandidates(explicitBase, process.env);
	for (const ref of candidates) {
		const res = spawnSync("git", ["merge-base", ref, "HEAD"], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		if (res.status === 0 && res.stdout.trim()) {
			return res.stdout.trim();
		}
	}
	return null;
}

function collectBranchChangedFiles(
	repoRoot: string,
	dirArg: string,
	explicitBase?: string,
): { files: Map<string, ChangeKind>; baseSha: string | null } {
	const baseSha = resolveDiffBase(repoRoot, explicitBase);
	let committed = new Map<string, ChangeKind>();

	if (baseSha) {
		const diffRes = spawnSync(
			"git",
			[
				"-c",
				"core.quotePath=false",
				"diff",
				"--name-status",
				"--find-renames=90%",
				baseSha,
				"HEAD",
				"--",
				dirArg,
			],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		if (diffRes.status === 0) {
			committed = parseGitDiffNameStatus(diffRes.stdout, dirArg);
		}
	}

	const statusRes = spawnSync(
		"git",
		[
			"-c",
			"core.quotePath=false",
			"status",
			"--porcelain=v1",
			"-uall",
			"--",
			dirArg,
		],
		{ cwd: repoRoot, encoding: "utf8" },
	);
	const workingTree =
		statusRes.status === 0
			? parseGitPorcelainStatus(statusRes.stdout, dirArg)
			: new Map<string, ChangeKind>();

	return {
		files: mergeChangedMaps(committed, workingTree),
		baseSha,
	};
}

export function runLintObserve(argv: readonly string[]): number {
	const opts = parseCliArgs(argv);
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const normDir = normalizeDirArg(opts.dir);
	const pkgDir = resolve(repoRoot, normDir || ".");

	// 二进制解析候选按序兜底：根 node_modules/.bin（eslint 为根 devDependency，
	// CI 全新 bun install 下 hoisted 链接在此）→ eslint-config 包内链接（本地旧装态）。
	// CI run 44996631172/45057288663：包内路径在全新安装下不存在，fail-closed 前先穷尽候选。
	const eslintBinCandidates = [
		resolve(repoRoot, "node_modules/.bin/eslint"),
		resolve(repoRoot, "packages/eslint-config/node_modules/.bin/eslint"),
	];
	const eslintBin = eslintBinCandidates.find((candidate) =>
		existsSync(candidate),
	);
	const configPath = resolve(pkgDir, "eslint.config.mjs");

	if (!eslintBin) {
		console.error(
			`[lint-observe] ESLint binary not found in candidates: ${eslintBinCandidates.join(", ")}`,
		);
		return 1;
	}
	if (!existsSync(configPath)) {
		console.error(`[lint-observe] ESLint config not found: ${configPath}`);
		return 1;
	}

	const eslintRes = spawnSync(
		eslintBin,
		["--config", "eslint.config.mjs", "--format", "json", "."],
		{
			cwd: pkgDir,
			encoding: "utf8",
			maxBuffer: 50 * 1024 * 1024,
		},
	);

	if (eslintRes.status !== 0 && eslintRes.status !== 1) {
		console.error(
			`[lint-observe] ESLint failed with exit ${eslintRes.status}: ${eslintRes.stderr}`,
		);
		return 1;
	}

	let parsedResults: EslintFileResult[];
	try {
		parsedResults = JSON.parse(eslintRes.stdout) as EslintFileResult[];
	} catch (err) {
		console.error(
			`[lint-observe] Failed to parse ESLint JSON output: ${String(err)}\n${eslintRes.stderr}`,
		);
		return 1;
	}

	const summary = summarizeObserveResults(parsedResults);
	const rulesText =
		summary.topRules.length > 0
			? summary.topRules.map((r) => `${r.ruleId}=${r.count}`).join(", ")
			: "none";
	console.log(
		`[lint-observe] ${normDir}: scanned ${summary.filesScanned} files, ${summary.totalErrors} errors, ${summary.totalWarnings} warnings (baseline observed; top: ${rulesText})`,
	);

	const { files: changedFiles, baseSha } = collectBranchChangedFiles(
		repoRoot,
		normDir,
		opts.base,
	);
	if (!baseSha) {
		if (shouldFailOnMissingDiffBase(opts.base, process.env)) {
			const tried = resolveDiffBaseCandidates(opts.base, process.env).join(", ");
			console.error(
				`[lint-observe] ${normDir}: BLOCKED — unable to resolve diff base against HEAD (tried: ${tried}). Pass --base <ref> or ensure git history is fetched.`,
			);
			return 1;
		}
		console.log(
			`[lint-observe] ${normDir}: diff base (dev / origin/dev) unavailable; enforcing on working-tree changes only`,
		);
	}

	const violations = evaluateObservePolicy(parsedResults, changedFiles, repoRoot);
	if (violations.length > 0) {
		console.error(
			`[lint-observe] ${normDir}: BLOCKED (${violations.length} changed file(s) failed policy):`,
		);
		for (const v of violations) {
			const ruleTag =
				v.changeKind === "added"
					? "added -> 0 error & 0 warning required"
					: "modified -> 0 error required";
			console.error(
				`  - ${v.relPath} [${ruleTag}] (${v.errorCount} errors, ${v.warningCount} warnings)`,
			);
			for (const msg of v.messages) {
				if (v.changeKind === "modified" && msg.severity < 2) continue;
				const sev = msg.severity === 2 ? "error" : "warn";
				console.error(
					`      L${msg.line}:${msg.column} [${sev}] ${msg.ruleId ?? "fatal"}: ${msg.message}`,
				);
			}
		}
		return 1;
	}

	console.log(
		`[lint-observe] ${normDir}: branch/working-tree gate passed (${changedFiles.size} changed file(s) checked)`,
	);
	return 0;
}

if (import.meta.main) {
	process.exitCode = runLintObserve(process.argv.slice(2));
}
