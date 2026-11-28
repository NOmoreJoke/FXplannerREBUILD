import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	COMPLIANCE_INLINE_ALLOW_MARKER,
	scanTextForComplianceViolations,
	type ComplianceTermCategory,
} from "../services/chat/src/ai/compliance/compliance-lexicon";

export interface ComplianceCopyViolation {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly term: string;
	readonly category: ComplianceTermCategory;
	readonly reason: string;
	readonly snippet: string;
}

export interface ComplianceScanSummary {
	readonly filesScanned: number;
	readonly violations: ComplianceCopyViolation[];
}

export interface ComplianceCliOptions {
	readonly paths?: string[];
	readonly stdin: boolean;
	readonly stdinFilename: string;
}

export const DEFAULT_SCAN_DIRS: readonly string[] = [
	"clients/chat-web/app",
	"clients/chat-web/components",
	"clients/chat-web/hooks",
	"clients/chat-web/lib",
	"services/chat/src",
];

const IGNORED_DIRS = new Set([
	"node_modules",
	".next",
	"dist",
	"build",
	"coverage",
	".turbo",
]);

const EXCLUDED_REL_FILES = new Set([
	"clients/chat-web/lib/api/schema.gen.ts",
	"services/chat/src/ai/compliance/compliance-lexicon.ts",
]);

const SOURCE_EXT_RE = /\.(ts|tsx)$/i;
const TEST_FILE_RE = /\.(spec|test)\.(ts|tsx)$/i;

type LexerMode =
	| { kind: "code" }
	| { kind: "string"; quote: "'" | '"' }
	| { kind: "template" }
	| { kind: "regex"; inCharClass: boolean }
	| { kind: "line_comment" }
	| { kind: "block_comment" };

const REGEX_PRECEDING_TOKENS = new Set([
	"",
	"(",
	"[",
	"{",
	",",
	";",
	":",
	"?",
	"=",
	"=>",
	"!",
	"&",
	"|",
	"^",
	"~",
	"+",
	"-",
	"*",
	"/",
	"%",
	"return",
	"throw",
	"case",
	"default",
	"delete",
	"void",
	"typeof",
	"await",
	"yield",
	"in",
	"instanceof",
	"new",
	"else",
	"do",
	"export",
	"of",
]);

function isIdentStart(ch: string): boolean {
	return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$";
}

function isIdentPart(ch: string): boolean {
	return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

/**
 * 字符级状态机剥离 // 与 /* *\/ 注释（覆盖 JSDoc 与 JSX {/* *\/}），
 * 完整识别字符串、模板字面量（含 ${...} 嵌套）与 JS/TS 正则字面量（含字符集 [...] 与转义），
 * 将注释字符替换为等长空格并保留换行符，避免正则误伤 "https://..." 或 /\/\//。
 */
export function stripCommentsPreservingPositions(source: string): string {
	const out: string[] = [];
	const stack: LexerMode[] = [{ kind: "code" }];
	const templateBraceDepths: number[] = [];
	let currentBraceDepth = 0;
	let lastToken = "";

	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		const next = i + 1 < source.length ? source[i + 1] : "";
		const mode = stack[stack.length - 1];

		if (mode.kind === "line_comment") {
			if (ch === "\n") {
				out.push("\n");
				stack.pop();
			} else {
				out.push(" ");
			}
			i++;
			continue;
		}

		if (mode.kind === "block_comment") {
			if (ch === "*" && next === "/") {
				out.push("  ");
				stack.pop();
				i += 2;
			} else {
				out.push(ch === "\n" ? "\n" : " ");
				i++;
			}
			continue;
		}

		if (mode.kind === "string") {
			out.push(ch);
			if (ch === "\\") {
				if (i + 1 < source.length) {
					out.push(source[i + 1]);
					i += 2;
					continue;
				}
			} else if (ch === mode.quote || ch === "\n") {
				stack.pop();
				lastToken = "LITERAL";
			}
			i++;
			continue;
		}

		if (mode.kind === "regex") {
			out.push(ch);
			if (ch === "\\") {
				if (i + 1 < source.length) {
					out.push(source[i + 1]);
					i += 2;
					continue;
				}
			} else if (ch === "[") {
				mode.inCharClass = true;
			} else if (ch === "]" && mode.inCharClass) {
				mode.inCharClass = false;
			} else if ((ch === "/" && !mode.inCharClass) || ch === "\n") {
				stack.pop();
				lastToken = "LITERAL";
			}
			i++;
			continue;
		}

		if (mode.kind === "template") {
			if (ch === "\\") {
				out.push(ch);
				if (i + 1 < source.length) {
					out.push(source[i + 1]);
					i += 2;
					continue;
				}
			} else if (ch === "`") {
				out.push(ch);
				stack.pop();
				lastToken = "LITERAL";
				i++;
				continue;
			} else if (ch === "$" && next === "{") {
				out.push("${");
				templateBraceDepths.push(currentBraceDepth);
				currentBraceDepth++;
				stack.push({ kind: "code" });
				lastToken = "{";
				i += 2;
				continue;
			}
			out.push(ch);
			i++;
			continue;
		}

		// mode.kind === "code"
		if (ch === "/" && next === "/") {
			out.push("  ");
			stack.push({ kind: "line_comment" });
			i += 2;
			continue;
		}
		if (ch === "/" && next === "*") {
			out.push("  ");
			stack.push({ kind: "block_comment" });
			i += 2;
			continue;
		}
		if (ch === "/") {
			const isJsxTagSlash = next === ">" || lastToken === "<";
			if (!isJsxTagSlash && REGEX_PRECEDING_TOKENS.has(lastToken)) {
				out.push(ch);
				stack.push({ kind: "regex", inCharClass: false });
				i++;
				continue;
			}
			out.push(ch);
			lastToken = "/";
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			out.push(ch);
			stack.push({ kind: "string", quote: ch });
			i++;
			continue;
		}
		if (ch === "`") {
			out.push(ch);
			stack.push({ kind: "template" });
			i++;
			continue;
		}
		if (ch === "=" && next === ">") {
			out.push("=>");
			lastToken = "=>";
			i += 2;
			continue;
		}
		if ((ch === "+" && next === "+") || (ch === "-" && next === "-")) {
			out.push(ch, next);
			lastToken = ch + next;
			i += 2;
			continue;
		}
		if (isIdentStart(ch)) {
			let end = i + 1;
			while (end < source.length && isIdentPart(source[end])) {
				end++;
			}
			const ident = source.slice(i, end);
			out.push(ident);
			lastToken = ident;
			i = end;
			continue;
		}
		if (ch >= "0" && ch <= "9") {
			let end = i + 1;
			while (end < source.length && (isIdentPart(source[end]) || source[end] === ".")) {
				end++;
			}
			out.push(source.slice(i, end));
			lastToken = "NUMBER";
			i = end;
			continue;
		}
		if (ch === "{") {
			currentBraceDepth++;
		} else if (ch === "}") {
			currentBraceDepth = Math.max(0, currentBraceDepth - 1);
			if (
				templateBraceDepths.length > 0 &&
				currentBraceDepth === templateBraceDepths[templateBraceDepths.length - 1]
			) {
				templateBraceDepths.pop();
				stack.pop();
				out.push(ch);
				lastToken = "}";
				i++;
				continue;
			}
		}

		if (ch !== " " && ch !== "\t" && ch !== "\r" && ch !== "\n") {
			lastToken = ch;
		}
		out.push(ch);
		i++;
	}

	return out.join("");
}

function isIncludedSourceFile(relPath: string): boolean {
	const normalized = relPath.replace(/\\/g, "/");
	if (EXCLUDED_REL_FILES.has(normalized)) {
		return false;
	}
	if (!SOURCE_EXT_RE.test(normalized) || TEST_FILE_RE.test(normalized)) {
		return false;
	}
	return true;
}

export function scanSourceText(
	content: string,
	relPath: string,
): ComplianceCopyViolation[] {
	const normalizedPath = relPath.replace(/\\/g, "/");
	if (!isIncludedSourceFile(normalizedPath)) {
		return [];
	}

	const rawLines = content.split(/\r?\n/);
	const strippedLines = stripCommentsPreservingPositions(content).split(/\r?\n/);
	const violations: ComplianceCopyViolation[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		const rawLine = rawLines[i] ?? "";
		const codeLine = strippedLines[i] ?? "";

		// 仅当 compliance-allow 出现在本行注释中（被剥离部分）时放行，防止字符串字面量伪造豁免
		if (
			rawLine.includes(COMPLIANCE_INLINE_ALLOW_MARKER) &&
			!codeLine.includes(COMPLIANCE_INLINE_ALLOW_MARKER)
		) {
			continue;
		}

		const matches = scanTextForComplianceViolations(codeLine);
		for (const match of matches) {
			violations.push({
				file: normalizedPath,
				line: i + 1,
				column: match.column,
				term: match.term,
				category: match.category,
				reason: match.reason,
				snippet: rawLine.trim().slice(0, 120),
			});
		}
	}

	return violations;
}

function walkSourceFiles(
	absPath: string,
	repoRoot: string,
	acc: string[],
): void {
	if (!existsSync(absPath)) {
		return;
	}
	const st = statSync(absPath);
	if (st.isFile()) {
		const relPath = relative(repoRoot, absPath).replace(/\\/g, "/");
		if (isIncludedSourceFile(relPath)) {
			acc.push(absPath);
		}
		return;
	}
	if (!st.isDirectory()) {
		return;
	}
	const entries = readdirSync(absPath, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	for (const entry of entries) {
		if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
			continue;
		}
		walkSourceFiles(resolve(absPath, entry.name), repoRoot, acc);
	}
}

export function scanPaths(
	repoRoot: string,
	targetDirs: readonly string[] = DEFAULT_SCAN_DIRS,
): ComplianceScanSummary {
	const files: string[] = [];
	for (const relTarget of targetDirs) {
		walkSourceFiles(resolve(repoRoot, relTarget), repoRoot, files);
	}

	const uniqueSortedFiles = [...new Set(files)].sort();
	const violations: ComplianceCopyViolation[] = [];

	for (const absFile of uniqueSortedFiles) {
		const relPath = relative(repoRoot, absFile).replace(/\\/g, "/");
		const content = readFileSync(absFile, "utf8");
		violations.push(...scanSourceText(content, relPath));
	}

	return {
		filesScanned: uniqueSortedFiles.length,
		violations,
	};
}

export function parseCliArgs(argv: readonly string[]): ComplianceCliOptions {
	let paths: string[] | undefined;
	let stdin = false;
	let stdinFilename = "stdin.ts";

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--stdin") {
			stdin = true;
		} else if (token === "--stdin-filename" && i + 1 < argv.length) {
			stdinFilename = argv[++i];
		} else if (token.startsWith("--stdin-filename=")) {
			stdinFilename = token.slice("--stdin-filename=".length);
		} else if (token === "--paths" && i + 1 < argv.length) {
			paths = argv[++i]
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		} else if (token.startsWith("--paths=")) {
			paths = token
				.slice("--paths=".length)
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
	}

	return { paths, stdin, stdinFilename };
}

export function runCheckComplianceCopy(
	argv: readonly string[],
	stdinText?: string,
	repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
): number {
	const opts = parseCliArgs(argv);

	if (opts.stdin) {
		const input = stdinText ?? readFileSync(0, "utf8");
		const violations = scanSourceText(input, opts.stdinFilename);
		if (violations.length > 0) {
			console.error(
				`[check:compliance-copy] 发现 ${violations.length} 处合规封杀词违规（--stdin ${opts.stdinFilename}）：`,
			);
			for (const v of violations) {
				console.error(
					`  ${v.file}:${v.line}:${v.column} [${v.category}:${v.term}] ${v.snippet}`,
				);
			}
			return 1;
		}
		console.log(
			`✅ 合规文案门禁检查通过（--stdin ${opts.stdinFilename}，0 违规）`,
		);
		return 0;
	}

	const summary = scanPaths(repoRoot, opts.paths ?? DEFAULT_SCAN_DIRS);
	if (summary.violations.length > 0) {
		console.error(
			`❌ 合规文案门禁检查未通过：扫描 ${summary.filesScanned} 个文件，发现 ${summary.violations.length} 处封杀词违规：`,
		);
		for (const v of summary.violations) {
			console.error(
				`  ${v.file}:${v.line}:${v.column} [${v.category}:${v.term}] ${v.snippet}`,
			);
		}
		console.error(
			"\n词源见 services/chat/src/ai/compliance/compliance-lexicon.ts；确属人工复核合规语境请在对应注释行加 compliance-allow。",
		);
		return 1;
	}

	console.log(
		`✅ 合规文案门禁检查通过（扫描 ${summary.filesScanned} 个文件，0 违规）`,
	);
	return 0;
}

if (import.meta.main) {
	process.exitCode = runCheckComplianceCopy(process.argv.slice(2));
}
