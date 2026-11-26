import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Node,
	Project,
	SyntaxKind,
	VariableDeclarationKind,
	ts,
	type CallExpression,
	type Expression,
	type ObjectLiteralExpression,
	type SourceFile,
	type TaggedTemplateExpression,
} from "ts-morph";

export type OrgScopeRuleId =
	| "RULE_A_BARE_ID"
	| "RULE_B_USER_ONLY_OR_COMPAT"
	| "RULE_C_RAW_SQL_NO_ORG"
	| "EMPTY_EXEMPT_REASON";

export interface OrgScopeViolation {
	filePath: string;
	line: number;
	column: number;
	rule: OrgScopeRuleId;
	message: string;
}

export interface ScanOrgScopeOptions {
	/** 仓库根目录（默认自动定位到 scripts/..） */
	rootDir?: string;
	/** 扫描目标模块（默认 12 个业务模块） */
	targetModules?: readonly string[];
	/** 直接传入虚拟源文件列表（用于单测或内存校验） */
	virtualFiles?: ReadonlyArray<{ filePath: string; content: string }>;
}

export interface ScanOrgScopeResult {
	filesScanned: number;
	violations: OrgScopeViolation[];
}

export const TARGET_MODULES = [
	"account",
	"plan",
	"transaction",
	"usage",
	"correction",
	"report",
	"reminder",
	"home",
	"onboarding",
	"audit",
	"data-request",
	"ai",
] as const;

export const TENANT_MODELS = new Set([
	"account",
	"transaction",
	"initialHolding",
	"costLot",
	"plan",
	"planChangeLog",
	"usageRecord",
	"correction",
	"reminder",
	"organizationSettings",
	"aiConversation",
]);

export const SHARED_LEDGER_MODELS_RULE_B = new Set([
	"account",
	"transaction",
	"initialHolding",
	"costLot",
	"plan",
	"planChangeLog",
	"usageRecord",
	"correction",
	"reminder",
	"organizationSettings",
]);

const SINGLE_RECORD_METHODS = new Set([
	"findUnique",
	"findUniqueOrThrow",
	"update",
	"delete",
	"upsert",
]);

const QUERY_AND_BULK_METHODS = new Set([
	"findMany",
	"findFirst",
	"findFirstOrThrow",
	"count",
	"aggregate",
	"updateMany",
	"deleteMany",
	"groupBy",
]);

const ALL_PRISMA_QUERY_METHODS = new Set([
	...SINGLE_RECORD_METHODS,
	...QUERY_AND_BULK_METHODS,
]);

const RAW_SQL_METHODS = new Set([
	"$queryRaw",
	"$executeRaw",
	"$queryRawUnsafe",
	"$executeRawUnsafe",
]);

const RAW_SQL_EXEMPT_FILENAMES = new Set([
	"organization-backfill.ts",
	"organization-reconcile.ts",
	"data-request-cleanup.ts",
]);

const TENANT_SQL_TABLES = [
	"accounts",
	"transactions",
	"initial_holdings",
	"cost_lots",
	"plans",
	"plan_change_logs",
	"usage_records",
	"corrections",
	"reminders",
	"organization_settings",
	"ai_conversations",
] as const;

const TENANT_SQL_TABLE_RE = new RegExp(
	`\\b(?:${TENANT_SQL_TABLES.join("|")})\\b`,
	"i",
);

const ORG_ID_FILTER_SQL_RE =
	/(?:\bWHERE\b|\bON\b|\bUSING\b|\bHAVING\b)[\s\S]*\b(?:\w+\.)?"?organization_id"?\s*(?:=|<>|!=|IS\b|IN\b|ANY\b)|(?:\bWHERE\b|\bON\b|\bUSING\b|\bHAVING\b)[\s\S]*=\s*ANY\s*\([^)]*\borganization_id\b/i;

const TRANSITIONAL_COMPAT_HELPERS = new Set([
	"compatReadWhere",
	"planReservationWhere",
	"organizationLedgerScope",
]);

const TRANSITIONAL_COMPAT_TYPES = new Set([
	"OrganizationLedgerScope",
	"PlanReservationWhere",
]);

const PRISMA_CLIENT_NAMES = new Set(["prisma", "tx", "db", "client"]);

const EXEMPT_TAG = "@org-scope-exempt";
const MIN_EXEMPT_REASON_LENGTH = 6;
const TRIVIAL_EXEMPT_RE =
	/^(?:todo|fixme|xxx|temp|tmp|hack|test|tbd|none|na|n\/a|\d+)$/i;

interface WhereAnalysis {
	hasId: boolean;
	hasOrganizationId: boolean;
	hasNullOrganizationId: boolean;
	hasUserId: boolean;
	usesTransitionalCompat: boolean;
	unresolvable: boolean;
}

interface ParsedExemptComment {
	line: number;
	column: number;
	hasTag: boolean;
	reason: string;
}

function emptyWhereAnalysis(unresolvable = false): WhereAnalysis {
	return {
		hasId: false,
		hasOrganizationId: false,
		hasNullOrganizationId: false,
		hasUserId: false,
		usesTransitionalCompat: false,
		unresolvable,
	};
}

function stripCommentWrapper(raw: string): string {
	if (raw.startsWith("//")) {
		return raw.slice(2).trim();
	}
	if (raw.startsWith("/*")) {
		return raw
			.slice(2, raw.endsWith("*/") ? -2 : undefined)
			.replace(/^\s*\*\s?/gm, "")
			.trim();
	}
	return raw.trim();
}

function isValidExemptReason(reason: string): boolean {
	const trimmed = reason.trim();
	if (trimmed.length < MIN_EXEMPT_REASON_LENGTH) return false;
	if (!/[a-zA-Z0-9\u4e00-\u9fff]/.test(trimmed)) return false;
	if (TRIVIAL_EXEMPT_RE.test(trimmed)) return false;
	return true;
}

function parseExemptFromCommentText(
	rawComment: string,
	line: number,
	column: number,
): ParsedExemptComment {
	const cleaned = stripCommentWrapper(rawComment);
	const idx = cleaned.indexOf(EXEMPT_TAG);
	if (idx === -1) {
		return { line, column, hasTag: false, reason: "" };
	}
	const afterTag = cleaned.slice(idx + EXEMPT_TAG.length);
	const colonMatch = /^\s*:\s*([\s\S]*)$/.exec(afterTag);
	if (!colonMatch) {
		return { line, column, hasTag: true, reason: "" };
	}
	const reason = colonMatch[1].trim();
	return {
		line,
		column,
		hasTag: true,
		reason: isValidExemptReason(reason) ? reason : "",
	};
}

function collectAllExemptComments(sourceFile: SourceFile): ParsedExemptComment[] {
	const text = sourceFile.getFullText();
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		false,
		ts.LanguageVariant.Standard,
		text,
	);
	const results: ParsedExemptComment[] = [];

	while (true) {
		const token = scanner.scan();
		if (token === ts.SyntaxKind.EndOfFileToken) break;
		if (
			token === ts.SyntaxKind.SingleLineCommentTrivia ||
			token === ts.SyntaxKind.MultiLineCommentTrivia
		) {
			const startPos = scanner.getTokenPos();
			const raw = scanner.getTokenText();
			const { line, column } = sourceFile.getLineAndColumnAtPos(startPos);
			const parsed = parseExemptFromCommentText(raw, line, column);
			if (parsed.hasTag) {
				results.push(parsed);
			}
		}
	}

	return results;
}

function commentRangesHaveValidExempt(
	node: Node,
	sourceFile: SourceFile,
	ranges: ReadonlyArray<{ getText(): string; getEnd(): number }>,
): boolean {
	const fullText = sourceFile.getFullText();
	for (const range of ranges) {
		const between = fullText.slice(range.getEnd(), node.getStart());
		if (/\r?\n[ \t]*\r?\n/.test(between)) {
			continue;
		}
		const parsed = parseExemptFromCommentText(range.getText(), 0, 0);
		if (parsed.hasTag && parsed.reason.length > 0) {
			return true;
		}
	}
	return false;
}

function hasValidExemptAnnotation(
	node: Node,
	sourceFile: SourceFile,
	extraNodes: ReadonlyArray<Node | undefined> = [],
): boolean {
	// 1. 仅沿单表达式/单语句向上检查，不在 ArrayLiteralExpression（如 Promise.all）处跨边界继承
	const hardStopKinds = new Set([
		SyntaxKind.Block,
		SyntaxKind.SourceFile,
		SyntaxKind.MethodDeclaration,
		SyntaxKind.FunctionDeclaration,
		SyntaxKind.ArrowFunction,
		SyntaxKind.FunctionExpression,
		SyntaxKind.IfStatement,
		SyntaxKind.ForStatement,
		SyntaxKind.ForOfStatement,
		SyntaxKind.WhileStatement,
		SyntaxKind.ClassDeclaration,
		SyntaxKind.ArrayLiteralExpression,
	]);
	const statementTerminalKinds = new Set([
		SyntaxKind.VariableStatement,
		SyntaxKind.ExpressionStatement,
		SyntaxKind.ReturnStatement,
	]);

	let cur: Node | undefined = node;
	while (cur && !hardStopKinds.has(cur.getKind())) {
		if (commentRangesHaveValidExempt(cur, sourceFile, cur.getLeadingCommentRanges())) {
			return true;
		}
		if (statementTerminalKinds.has(cur.getKind())) {
			break;
		}
		cur = cur.getParent();
	}

	for (const extra of extraNodes) {
		if (extra && commentRangesHaveValidExempt(extra, sourceFile, extra.getLeadingCommentRanges())) {
			return true;
		}
	}

	// 2. 检查紧邻调用行上方的连续注释行（不允许跨越空行）
	const lines = sourceFile.getFullText().split(/\r?\n/);
	const startLine = node.getStartLineNumber();
	for (let lineIdx = startLine - 2; lineIdx >= 0; lineIdx--) {
		const trimmed = (lines[lineIdx] ?? "").trim();
		if (trimmed === "") break;
		if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
			const parsed = parseExemptFromCommentText(trimmed, lineIdx + 1, 1);
			if (parsed.hasTag && parsed.reason.length > 0) {
				return true;
			}
			continue;
		}
		break;
	}

	return false;
}

function unwrapExpression(expr: Expression): Expression {
	let current = expr;
	while (true) {
		if (Node.isParenthesizedExpression(current)) {
			current = current.getExpression();
		} else if (Node.isAwaitExpression(current)) {
			current = current.getExpression();
		} else if (Node.isAsExpression(current)) {
			current = current.getExpression();
		} else if (Node.isSatisfiesExpression(current)) {
			current = current.getExpression();
		} else if (Node.isTypeAssertion(current)) {
			current = current.getExpression();
		} else if (Node.isNonNullExpression(current)) {
			current = current.getExpression();
		} else {
			break;
		}
	}
	return current;
}

interface LocalDeclaration {
	initializer?: Expression;
	typeText?: string;
	isMutableOrMutated: boolean;
	bindingPropertyName?: string;
}

function isVariableMutatedInScope(
	varName: string,
	declPos: number,
	scopeNode: Node,
	beforePos: number,
): boolean {
	for (const bin of scopeNode.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
		if (bin.getStart() <= declPos || bin.getStart() >= beforePos) continue;
		const op = bin.getOperatorToken().getText();
		if (
			op !== "=" &&
			op !== "+=" &&
			op !== "-=" &&
			op !== "??=" &&
			op !== "||=" &&
			op !== "&&="
		) {
			continue;
		}
		const left = unwrapExpression(bin.getLeft());
		if (Node.isIdentifier(left) && left.getText() === varName) return true;
		if (
			(Node.isPropertyAccessExpression(left) || Node.isElementAccessExpression(left)) &&
			unwrapExpression(left.getExpression()).getText() === varName
		) {
			return true;
		}
	}
	for (const call of scopeNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		if (call.getStart() <= declPos || call.getStart() >= beforePos) continue;
		const calleeText = call.getExpression().getText();
		if (calleeText === "Object.assign") {
			const firstArg = call.getArguments()[0];
			if (firstArg && Node.isIdentifier(firstArg) && firstArg.getText() === varName) {
				return true;
			}
		}
	}
	return false;
}

function findLocalDeclaration(
	name: string,
	fromNode: Node,
): LocalDeclaration | null {
	let current: Node | undefined = fromNode.getParent();
	while (current) {
		if (Node.isBlock(current) || Node.isSourceFile(current)) {
			const varStatements = current.getStatements().filter(Node.isVariableStatement);
			for (let i = varStatements.length - 1; i >= 0; i--) {
				const stmt = varStatements[i];
				if (stmt.getStart() > fromNode.getStart()) continue;
				const declList = stmt.getDeclarationList();
				const isConstDecl =
					declList.getDeclarationKind() === VariableDeclarationKind.Const;

				for (const decl of stmt.getDeclarations()) {
					if (decl.getName() === name) {
						const mutated =
							!isConstDecl ||
							isVariableMutatedInScope(
								name,
								decl.getStart(),
								current,
								fromNode.getStart(),
							);
						return {
							initializer: decl.getInitializer(),
							typeText: decl.getTypeNode()?.getText(),
							isMutableOrMutated: mutated,
						};
					}
					const nameNode = decl.getNameNode();
					if (Node.isArrayBindingPattern(nameNode)) {
						const elements = nameNode.getElements();
						const idx = elements.findIndex(
							(el) => Node.isBindingElement(el) && el.getName() === name,
						);
						if (idx !== -1 && decl.getInitializer()) {
							const init = unwrapExpression(decl.getInitializer()!);
							if (
								Node.isCallExpression(init) &&
								init.getExpression().getText() === "Promise.all"
							) {
								const arg0 = init.getArguments()[0];
								if (arg0 && Node.isArrayLiteralExpression(arg0)) {
									const matched = arg0.getElements()[idx];
									if (matched && Node.isExpression(matched)) {
										return {
											initializer: matched,
											isMutableOrMutated: !isConstDecl,
										};
									}
								}
							} else if (Node.isArrayLiteralExpression(init)) {
								const matched = init.getElements()[idx];
								if (matched && Node.isExpression(matched)) {
									return {
										initializer: matched,
										isMutableOrMutated: !isConstDecl,
									};
								}
							}
						}
					} else if (Node.isObjectBindingPattern(nameNode)) {
						for (const el of nameNode.getElements()) {
							if (Node.isBindingElement(el) && el.getName() === name) {
								const propName = el.getPropertyNameNode()?.getText() ?? name;
								return {
									initializer: decl.getInitializer(),
									bindingPropertyName: propName.replace(/^["']|["']$/g, ""),
									isMutableOrMutated: !isConstDecl,
								};
							}
						}
					}
				}
			}
		}
		if (Node.isFunctionLikeDeclaration(current)) {
			for (const param of current.getParameters()) {
				if (param.getName() === name) {
					return {
						initializer: param.getInitializer(),
						typeText: param.getTypeNode()?.getText(),
						isMutableOrMutated: false,
					};
				}
			}
		}
		current = current.getParent();
	}
	return null;
}

function getStaticStringValue(expr: Expression, fromNode: Node): string | null {
	const unwrapped = unwrapExpression(expr);
	if (Node.isStringLiteral(unwrapped) || Node.isNoSubstitutionTemplateLiteral(unwrapped)) {
		return unwrapped.getLiteralText();
	}
	if (Node.isIdentifier(unwrapped)) {
		const decl = findLocalDeclaration(unwrapped.getText(), fromNode);
		if (decl && !decl.isMutableOrMutated && decl.initializer) {
			const init = unwrapExpression(decl.initializer);
			if (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) {
				return init.getLiteralText();
			}
		}
	}
	return null;
}

function getMemberName(
	node: Expression,
	fromNode: Node,
): { name: string | null; isDynamicElementAccess: boolean; receiver: Expression } | null {
	const unwrapped = unwrapExpression(node);
	if (Node.isPropertyAccessExpression(unwrapped)) {
		return {
			name: unwrapped.getName(),
			isDynamicElementAccess: false,
			receiver: unwrapped.getExpression(),
		};
	}
	if (Node.isElementAccessExpression(unwrapped)) {
		const argExpr = unwrapped.getArgumentExpression();
		const staticName = argExpr ? getStaticStringValue(argExpr, fromNode) : null;
		return {
			name: staticName,
			isDynamicElementAccess: staticName === null,
			receiver: unwrapped.getExpression(),
		};
	}
	return null;
}

function looksLikePrismaClient(expr: Expression): boolean {
	const unwrapped = unwrapExpression(expr);
	if (Node.isThisExpression(unwrapped)) return false;
	if (Node.isIdentifier(unwrapped)) {
		return PRISMA_CLIENT_NAMES.has(unwrapped.getText());
	}
	if (Node.isPropertyAccessExpression(unwrapped)) {
		return PRISMA_CLIENT_NAMES.has(unwrapped.getName());
	}
	if (Node.isElementAccessExpression(unwrapped)) {
		const arg = unwrapped.getArgumentExpression();
		if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
			return PRISMA_CLIENT_NAMES.has(arg.getLiteralText());
		}
	}
	return false;
}

function isUndefinedOrNullInitializer(initializer: Expression | undefined): "null" | "undefined" | "value" {
	if (!initializer) return "value";
	const unwrapped = unwrapExpression(initializer);
	if (unwrapped.getKind() === SyntaxKind.NullKeyword) return "null";
	if (
		(Node.isIdentifier(unwrapped) && unwrapped.getText() === "undefined") ||
		Node.isVoidExpression(unwrapped)
	) {
		return "undefined";
	}
	return "value";
}

function combineDisjunction(branches: readonly WhereAnalysis[]): WhereAnalysis {
	if (branches.length === 0) {
		return emptyWhereAnalysis(true);
	}
	return {
		hasId: branches.some((b) => b.hasId),
		// 析取语义（OR / 三元）：仅当【全部】分支均保证 organizationId 时才成立
		hasOrganizationId: branches.every((b) => b.hasOrganizationId),
		hasNullOrganizationId: branches.some((b) => b.hasNullOrganizationId),
		hasUserId: branches.some((b) => b.hasUserId),
		usesTransitionalCompat: branches.some((b) => b.usesTransitionalCompat),
		unresolvable: branches.some((b) => b.unresolvable),
	};
}

function analyzeLogicalArray(
	expr: Expression,
	mode: "AND" | "OR",
	fromNode: Node,
	visitedVars: Set<string>,
): WhereAnalysis {
	const unwrapped = unwrapExpression(expr);
	if (!Node.isArrayLiteralExpression(unwrapped)) {
		return analyzeExpression(unwrapped, fromNode, visitedVars);
	}
	const branches: WhereAnalysis[] = [];
	for (const el of unwrapped.getElements()) {
		if (Node.isSpreadElement(el)) {
			const spreadUnwrapped = unwrapExpression(el.getExpression());
			if (Node.isConditionalExpression(spreadUnwrapped)) {
				const whenTrue = unwrapExpression(spreadUnwrapped.getWhenTrue());
				const whenFalse = unwrapExpression(spreadUnwrapped.getWhenFalse());
				if (Node.isArrayLiteralExpression(whenTrue)) {
					for (const sub of whenTrue.getElements()) {
						branches.push(analyzeExpression(sub, fromNode, visitedVars));
					}
				} else {
					branches.push(analyzeExpression(whenTrue, fromNode, visitedVars));
				}
				if (Node.isArrayLiteralExpression(whenFalse) && whenFalse.getElements().length === 0) {
					// 空数组三元分支（如 ...(cond ? [legacyBranch] : [])）：不影响已有确定分支的 AND/OR 语义，仅保留已展开分支的 compat 告警
				} else if (Node.isArrayLiteralExpression(whenFalse)) {
					for (const sub of whenFalse.getElements()) {
						branches.push(analyzeExpression(sub, fromNode, visitedVars));
					}
				} else {
					branches.push(analyzeExpression(whenFalse, fromNode, visitedVars));
				}
				continue;
			}
			branches.push(analyzeExpression(spreadUnwrapped, fromNode, visitedVars));
			continue;
		}
		branches.push(analyzeExpression(el, fromNode, visitedVars));
	}

	if (mode === "OR") {
		return combineDisjunction(branches);
	}
	return {
		hasId: branches.some((b) => b.hasId),
		hasOrganizationId: branches.some((b) => b.hasOrganizationId),
		hasNullOrganizationId: branches.some((b) => b.hasNullOrganizationId),
		hasUserId: branches.some((b) => b.hasUserId),
		usesTransitionalCompat: branches.some((b) => b.usesTransitionalCompat),
		unresolvable: branches.some((b) => b.unresolvable),
	};
}

function analyzeExpression(
	expr: Expression,
	fromNode: Node,
	visitedVars: Set<string>,
): WhereAnalysis {
	const unwrapped = unwrapExpression(expr);

	if (Node.isSpreadElement(unwrapped)) {
		return analyzeExpression(unwrapped.getExpression(), fromNode, visitedVars);
	}

	if (Node.isObjectLiteralExpression(unwrapped)) {
		return analyzeObjectLiteral(unwrapped, fromNode, visitedVars);
	}

	if (Node.isArrayLiteralExpression(unwrapped)) {
		const branches = unwrapped
			.getElements()
			.map((el) => analyzeExpression(el, fromNode, visitedVars));
		return combineDisjunction(branches);
	}

	if (Node.isConditionalExpression(unwrapped)) {
		return combineDisjunction([
			analyzeExpression(unwrapped.getWhenTrue(), fromNode, visitedVars),
			analyzeExpression(unwrapped.getWhenFalse(), fromNode, visitedVars),
		]);
	}

	if (Node.isBinaryExpression(unwrapped)) {
		const op = unwrapped.getOperatorToken().getText();
		if (op === "&&") {
			const right = analyzeExpression(unwrapped.getRight(), fromNode, visitedVars);
			return {
				...right,
				// `cond && { organizationId }` 当 cond 为 falsy 时求值为 false，不能保证 organizationId
				hasOrganizationId: false,
			};
		}
		return combineDisjunction([
			analyzeExpression(unwrapped.getLeft(), fromNode, visitedVars),
			analyzeExpression(unwrapped.getRight(), fromNode, visitedVars),
		]);
	}

	if (Node.isCallExpression(unwrapped)) {
		const callee = unwrapExpression(unwrapped.getExpression());
		const calleeName = Node.isPropertyAccessExpression(callee)
			? callee.getName()
			: Node.isIdentifier(callee)
				? callee.getText()
				: "";

		if (TRANSITIONAL_COMPAT_HELPERS.has(calleeName)) {
			return {
				hasId: false,
				hasOrganizationId: true,
				hasNullOrganizationId: true,
				hasUserId: true,
				usesTransitionalCompat: true,
				unresolvable: false,
			};
		}
		if (calleeName === "ownedRecordWhere") {
			return {
				hasId: true,
				hasOrganizationId: true,
				hasNullOrganizationId: false,
				hasUserId: false,
				usesTransitionalCompat: false,
				unresolvable: false,
			};
		}
		if (calleeName === "orgWhere" || calleeName === "conversationOrgWhere") {
			return {
				hasId: false,
				hasOrganizationId: true,
				hasNullOrganizationId: false,
				hasUserId: false,
				usesTransitionalCompat: false,
				unresolvable: false,
			};
		}
		// Object.assign 或未入白名单的动态构造器：fail-closed
		return emptyWhereAnalysis(true);
	}

	if (Node.isIdentifier(unwrapped)) {
		const name = unwrapped.getText();
		if (visitedVars.has(name)) return emptyWhereAnalysis(true);
		visitedVars.add(name);
		const decl = findLocalDeclaration(name, unwrapped);
		if (!decl) return emptyWhereAnalysis(true);

		if (decl.typeText && TRANSITIONAL_COMPAT_TYPES.has(decl.typeText.trim())) {
			return {
				hasId: false,
				hasOrganizationId: true,
				hasNullOrganizationId: true,
				hasUserId: true,
				usesTransitionalCompat: true,
				unresolvable: false,
			};
		}
		if (decl.isMutableOrMutated || !decl.initializer) {
			return emptyWhereAnalysis(true);
		}
		return analyzeExpression(decl.initializer, fromNode, visitedVars);
	}

	return emptyWhereAnalysis(true);
}

function analyzeObjectLiteral(
	obj: ObjectLiteralExpression,
	fromNode: Node,
	visitedVars: Set<string>,
): WhereAnalysis {
	const result = emptyWhereAnalysis();
	let directUserId = false;
	let directNullOrgId = false;

	for (const prop of obj.getProperties()) {
		if (Node.isSpreadAssignment(prop)) {
			const spread = analyzeExpression(prop.getExpression(), fromNode, visitedVars);
			result.hasId ||= spread.hasId;
			result.hasOrganizationId ||= spread.hasOrganizationId;
			result.hasNullOrganizationId ||= spread.hasNullOrganizationId;
			result.hasUserId ||= spread.hasUserId;
			result.usesTransitionalCompat ||= spread.usesTransitionalCompat;
			result.unresolvable ||= spread.unresolvable;
			continue;
		}

		let propName = "";
		let initializer: Expression | undefined;
		if (Node.isPropertyAssignment(prop)) {
			propName = prop.getName().replace(/^["']|["']$/g, "");
			initializer = prop.getInitializer();
		} else if (Node.isShorthandPropertyAssignment(prop)) {
			propName = prop.getName();
		} else {
			continue;
		}

		if (propName === "id") {
			result.hasId = true;
		} else if (propName === "userId") {
			result.hasUserId = true;
			directUserId = true;
		} else if (propName === "organizationId") {
			const kind = isUndefinedOrNullInitializer(initializer);
			if (kind === "null") {
				result.hasNullOrganizationId = true;
				result.hasOrganizationId = false;
				directNullOrgId = true;
			} else if (kind === "undefined") {
				result.hasOrganizationId = false;
			} else if (initializer && Node.isConditionalExpression(unwrapExpression(initializer))) {
				const cond = unwrapExpression(initializer) as import("ts-morph").ConditionalExpression;
				const tKind = isUndefinedOrNullInitializer(cond.getWhenTrue());
				const fKind = isUndefinedOrNullInitializer(cond.getWhenFalse());
				result.hasOrganizationId = tKind === "value" && fKind === "value";
				if (tKind === "null" || fKind === "null") {
					result.hasNullOrganizationId = true;
				}
			} else {
				result.hasOrganizationId = true;
			}
		} else if (
			propName.startsWith("organizationId_") ||
			propName.endsWith("_organizationId")
		) {
			const kind = isUndefinedOrNullInitializer(initializer);
			if (kind === "value") {
				result.hasOrganizationId = true;
			}
		} else if (propName === "AND" && initializer) {
			const sub = analyzeLogicalArray(initializer, "AND", fromNode, visitedVars);
			result.hasId ||= sub.hasId;
			result.hasOrganizationId ||= sub.hasOrganizationId;
			result.hasNullOrganizationId ||= sub.hasNullOrganizationId;
			result.hasUserId ||= sub.hasUserId;
			result.usesTransitionalCompat ||= sub.usesTransitionalCompat;
			result.unresolvable ||= sub.unresolvable;
		} else if (propName === "OR" && initializer) {
			const sub = analyzeLogicalArray(initializer, "OR", fromNode, visitedVars);
			result.hasId ||= sub.hasId;
			result.hasOrganizationId ||= sub.hasOrganizationId;
			result.hasNullOrganizationId ||= sub.hasNullOrganizationId;
			result.hasUserId ||= sub.hasUserId;
			result.usesTransitionalCompat ||= sub.usesTransitionalCompat;
			result.unresolvable ||= sub.unresolvable;
		} else if (propName === "NOT" && initializer) {
			// NOT: { organizationId } 绝对不能提供 hasOrganizationId
			const sub = analyzeExpression(initializer, fromNode, visitedVars);
			result.hasUserId ||= sub.hasUserId;
			result.usesTransitionalCompat ||= sub.usesTransitionalCompat;
		}
	}

	if (directUserId && directNullOrgId) {
		result.usesTransitionalCompat = true;
	}

	return result;
}

function getWherePropertyInfo(callExpr: CallExpression): {
	hasArg0: boolean;
	argUnresolvable: boolean;
	whereExpr?: Expression;
	wherePropNode?: Node;
} {
	const arg0 = callExpr.getArguments()[0];
	if (!arg0) return { hasArg0: false, argUnresolvable: false };
	if (!Node.isExpression(arg0)) return { hasArg0: true, argUnresolvable: true };

	const unwrappedArg = unwrapExpression(arg0);
	let objLit: ObjectLiteralExpression | undefined;
	if (Node.isObjectLiteralExpression(unwrappedArg)) {
		objLit = unwrappedArg;
	} else if (Node.isIdentifier(unwrappedArg)) {
		const decl = findLocalDeclaration(unwrappedArg.getText(), unwrappedArg);
		if (decl && !decl.isMutableOrMutated && decl.initializer) {
			const init = unwrapExpression(decl.initializer);
			if (Node.isObjectLiteralExpression(init)) objLit = init;
		}
	}
	if (!objLit) return { hasArg0: true, argUnresolvable: true };

	const whereProp = objLit.getProperty("where");
	if (!whereProp) return { hasArg0: true, argUnresolvable: false };
	if (Node.isPropertyAssignment(whereProp)) {
		return {
			hasArg0: true,
			argUnresolvable: false,
			whereExpr: whereProp.getInitializer(),
			wherePropNode: whereProp,
		};
	}
	if (Node.isShorthandPropertyAssignment(whereProp)) {
		return {
			hasArg0: true,
			argUnresolvable: false,
			whereExpr: whereProp.getNameNode(),
			wherePropNode: whereProp,
		};
	}
	return { hasArg0: true, argUnresolvable: true };
}

interface ExtractedSql {
	text: string | null;
	isStatic: boolean;
}

function extractSqlFromExpression(
	expr: Expression,
	fromNode: Node,
	visitedVars: Set<string>,
): ExtractedSql {
	const unwrapped = unwrapExpression(expr);

	if (Node.isStringLiteral(unwrapped) || Node.isNoSubstitutionTemplateLiteral(unwrapped)) {
		return { text: unwrapped.getLiteralText(), isStatic: true };
	}

	if (Node.isTemplateExpression(unwrapped)) {
		const parts = [unwrapped.getHead().getLiteralText()];
		let isStatic = true;
		for (const span of unwrapped.getTemplateSpans()) {
			const spanExpr = unwrapExpression(span.getExpression());
			if (Node.isTaggedTemplateExpression(spanExpr)) {
				const tagSql = extractSqlFromTaggedTemplate(spanExpr, fromNode, visitedVars);
				parts.push(tagSql.text ?? "$param");
				isStatic &&= tagSql.isStatic;
			} else {
				parts.push("$param");
			}
			parts.push(span.getLiteral().getLiteralText());
		}
		return { text: parts.join(" "), isStatic };
	}

	if (Node.isTaggedTemplateExpression(unwrapped)) {
		return extractSqlFromTaggedTemplate(unwrapped, fromNode, visitedVars);
	}

	if (Node.isBinaryExpression(unwrapped) && unwrapped.getOperatorToken().getText() === "+") {
		const left = extractSqlFromExpression(unwrapped.getLeft(), fromNode, visitedVars);
		const right = extractSqlFromExpression(unwrapped.getRight(), fromNode, visitedVars);
		if (!left.isStatic || !right.isStatic || left.text === null || right.text === null) {
			return { text: null, isStatic: false };
		}
		return { text: `${left.text} ${right.text}`, isStatic: true };
	}

	if (Node.isIdentifier(unwrapped)) {
		const name = unwrapped.getText();
		if (visitedVars.has(name)) return { text: null, isStatic: false };
		visitedVars.add(name);
		const decl = findLocalDeclaration(name, unwrapped);
		if (!decl || decl.isMutableOrMutated || !decl.initializer) {
			return { text: null, isStatic: false };
		}
		return extractSqlFromExpression(decl.initializer, fromNode, visitedVars);
	}

	return { text: null, isStatic: false };
}

function extractSqlFromTaggedTemplate(
	node: TaggedTemplateExpression,
	fromNode: Node,
	visitedVars: Set<string>,
): ExtractedSql {
	const template = node.getTemplate();
	if (Node.isNoSubstitutionTemplateLiteral(template)) {
		return { text: template.getLiteralText(), isStatic: true };
	}
	if (Node.isTemplateExpression(template)) {
		const parts = [template.getHead().getLiteralText()];
		let isStatic = true;
		for (const span of template.getTemplateSpans()) {
			const spanExpr = unwrapExpression(span.getExpression());
			if (Node.isTaggedTemplateExpression(spanExpr)) {
				const inner = extractSqlFromTaggedTemplate(spanExpr, fromNode, visitedVars);
				parts.push(inner.text ?? "$param");
				isStatic &&= inner.isStatic;
			} else {
				parts.push("$param");
			}
			parts.push(span.getLiteral().getLiteralText());
		}
		return { text: parts.join(" "), isStatic };
	}
	return { text: null, isStatic: false };
}

function stripSqlComments(sql: string): string {
	return sql
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/--[^\r\n]*/g, " ");
}

function checkRawSqlNode(
	node: TaggedTemplateExpression | CallExpression,
	methodName: string,
	extracted: ExtractedSql,
	sourceFile: SourceFile,
	displayPath: string,
	violations: OrgScopeViolation[],
): void {
	if (hasValidExemptAnnotation(node, sourceFile)) return;

	if (!extracted.isStatic || extracted.text === null) {
		const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
		violations.push({
			filePath: displayPath,
			line,
			column,
			rule: "RULE_C_RAW_SQL_NO_ORG",
			message: `原始 SQL (${methodName}) SQL 文本无法静态解析（fail-closed；请改用静态模板或加有效 // @org-scope-exempt: <理由>）`,
		});
		return;
	}

	const cleanedSql = stripSqlComments(extracted.text);
	if (TENANT_SQL_TABLE_RE.test(cleanedSql) && !ORG_ID_FILTER_SQL_RE.test(cleanedSql)) {
		const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
		violations.push({
			filePath: displayPath,
			line,
			column,
			rule: "RULE_C_RAW_SQL_NO_ORG",
			message: `原始 SQL (${methodName}) 访问了租户业务表但未在过滤条件中包含 organization_id（如需例外请加有效 // @org-scope-exempt: <理由>）`,
		});
	}
}

interface ResolvedPrismaCall {
	kind: "raw-sql" | "model-method" | "dynamic-model-method";
	methodName: string;
	modelName?: string;
}

function resolveDelegateModelName(
	expr: Expression,
	fromNode: Node,
	visited = new Set<string>(),
): { modelName: string | null; isDynamicPrismaDelegate: boolean } {
	const unwrapped = unwrapExpression(expr);
	const member = getMemberName(unwrapped, fromNode);
	if (member) {
		if (member.isDynamicElementAccess && looksLikePrismaClient(member.receiver)) {
			return { modelName: null, isDynamicPrismaDelegate: true };
		}
		if (member.name && TENANT_MODELS.has(member.name)) {
			return { modelName: member.name, isDynamicPrismaDelegate: false };
		}
		return { modelName: null, isDynamicPrismaDelegate: false };
	}

	if (Node.isIdentifier(unwrapped)) {
		const varName = unwrapped.getText();
		if (visited.has(varName)) return { modelName: null, isDynamicPrismaDelegate: false };
		visited.add(varName);
		const decl = findLocalDeclaration(varName, unwrapped);
		if (!decl || !decl.initializer) {
			return { modelName: null, isDynamicPrismaDelegate: false };
		}
		if (decl.bindingPropertyName) {
			if (
				TENANT_MODELS.has(decl.bindingPropertyName) &&
				looksLikePrismaClient(decl.initializer)
			) {
				return {
					modelName: decl.bindingPropertyName,
					isDynamicPrismaDelegate: false,
				};
			}
			return { modelName: null, isDynamicPrismaDelegate: false };
		}
		return resolveDelegateModelName(decl.initializer, fromNode, visited);
	}

	return { modelName: null, isDynamicPrismaDelegate: false };
}

function resolveCallTarget(
	calleeExpr: Expression,
	fromNode: Node,
): ResolvedPrismaCall | null {
	const unwrappedCallee = unwrapExpression(calleeExpr);

	// 直接调用别名函数（例如 const fn = prisma.$queryRawUnsafe; fn(...)）
	if (Node.isIdentifier(unwrappedCallee)) {
		const decl = findLocalDeclaration(unwrappedCallee.getText(), unwrappedCallee);
		if (!decl || !decl.initializer) return null;
		if (decl.bindingPropertyName) {
			if (
				RAW_SQL_METHODS.has(decl.bindingPropertyName) &&
				looksLikePrismaClient(decl.initializer)
			) {
				return { kind: "raw-sql", methodName: decl.bindingPropertyName };
			}
			return null;
		}
		return resolveCallTarget(decl.initializer, fromNode);
	}

	const member = getMemberName(unwrappedCallee, fromNode);
	if (!member) return null;

	const methodName = member.name;
	if (methodName && RAW_SQL_METHODS.has(methodName)) {
		return { kind: "raw-sql", methodName };
	}

	const delegate = resolveDelegateModelName(member.receiver, fromNode);
	if (delegate.isDynamicPrismaDelegate) {
		if (!methodName || ALL_PRISMA_QUERY_METHODS.has(methodName)) {
			return {
				kind: "dynamic-model-method",
				methodName: methodName ?? "[dynamic]",
			};
		}
		return null;
	}

	if (delegate.modelName && TENANT_MODELS.has(delegate.modelName)) {
		if (member.isDynamicElementAccess) {
			return {
				kind: "model-method",
				modelName: delegate.modelName,
				methodName: "[dynamic]",
			};
		}
		if (methodName && ALL_PRISMA_QUERY_METHODS.has(methodName)) {
			return {
				kind: "model-method",
				modelName: delegate.modelName,
				methodName,
			};
		}
	}

	return null;
}

function inspectSourceFile(
	sourceFile: SourceFile,
	displayPath: string,
): OrgScopeViolation[] {
	const violations: OrgScopeViolation[] = [];
	const fileName = basename(sourceFile.getFilePath());

	// 0. 空理由 / 敷衍占位理由 @org-scope-exempt 拦截
	for (const comment of collectAllExemptComments(sourceFile)) {
		if (comment.hasTag && comment.reason.length === 0) {
			violations.push({
				filePath: displayPath,
				line: comment.line,
				column: comment.column,
				rule: "EMPTY_EXEMPT_REASON",
				message:
					"@org-scope-exempt 必须提供非空明确理由（≥ 6 字符且非 TODO/FIXME/temp 等占位词）",
			});
		}
	}

	// 1. Prisma 方法调用扫描（规则 A & 规则 B & 规则 C CallExpression）
	for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		const resolved = resolveCallTarget(callExpr.getExpression(), callExpr);
		if (!resolved) continue;

		if (resolved.kind === "raw-sql") {
			if (!RAW_SQL_EXEMPT_FILENAMES.has(fileName)) {
				const extracted = extractSqlFromExpression(
					callExpr.getArguments()[0] as Expression,
					callExpr,
					new Set<string>(),
				);
				checkRawSqlNode(
					callExpr,
					resolved.methodName,
					extracted,
					sourceFile,
					displayPath,
					violations,
				);
			}
			continue;
		}

		if (resolved.kind === "dynamic-model-method") {
			if (!hasValidExemptAnnotation(callExpr, sourceFile)) {
				const { line, column } = sourceFile.getLineAndColumnAtPos(
					callExpr.getStart(),
				);
				violations.push({
					filePath: displayPath,
					line,
					column,
					rule: "RULE_B_USER_ONLY_OR_COMPAT",
					message: `动态 Prisma 模型下标访问 .${resolved.methodName}() 无法静态验证组织隔离（fail-closed；请改用静态模型或加有效 // @org-scope-exempt: <理由>）`,
				});
			}
			continue;
		}

		const modelName = resolved.modelName!;
		const methodName = resolved.methodName;

		const whereInfo = getWherePropertyInfo(callExpr);
		const isExempt = hasValidExemptAnnotation(callExpr, sourceFile, [
			whereInfo.wherePropNode,
		]);
		if (isExempt) continue;

		if (methodName === "[dynamic]") {
			const { line, column } = sourceFile.getLineAndColumnAtPos(
				callExpr.getStart(),
			);
			violations.push({
				filePath: displayPath,
				line,
				column,
				rule: "RULE_B_USER_ONLY_OR_COMPAT",
				message: `租户模型 ${modelName} 使用动态方法名下标调用，无法静态验证组织隔离（fail-closed）`,
			});
			continue;
		}

		const analysis = whereInfo.argUnresolvable
			? emptyWhereAnalysis(true)
			: whereInfo.whereExpr
				? analyzeExpression(whereInfo.whereExpr, callExpr, new Set<string>())
				: emptyWhereAnalysis(false);

		const isSingleRecord = SINGLE_RECORD_METHODS.has(methodName);
		const isAiConversation = modelName === "aiConversation";

		if (isAiConversation) {
			if (analysis.unresolvable || !analysis.hasOrganizationId) {
				const { line, column } = sourceFile.getLineAndColumnAtPos(
					callExpr.getStart(),
				);
				violations.push({
					filePath: displayPath,
					line,
					column,
					rule: isSingleRecord ? "RULE_A_BARE_ID" : "RULE_B_USER_ONLY_OR_COMPAT",
					message: `aiConversation.${methodName}() 的 where 必须包含 organizationId / conversationOrgWhere 组织隔离（或添加有效 // @org-scope-exempt: <理由>）`,
				});
			}
			continue;
		}

		if (SHARED_LEDGER_MODELS_RULE_B.has(modelName)) {
			if (analysis.usesTransitionalCompat) {
				const { line, column } = sourceFile.getLineAndColumnAtPos(
					callExpr.getStart(),
				);
				violations.push({
					filePath: displayPath,
					line,
					column,
					rule: "RULE_B_USER_ONLY_OR_COMPAT",
					message: `共享账本模型 ${modelName}.${methodName}() 使用了过渡期 compat/userId 回落，必须标注有效 // @org-scope-exempt: W30 MIG-D/F 待清理`,
				});
				continue;
			}

			if (analysis.unresolvable || !analysis.hasOrganizationId) {
				const { line, column } = sourceFile.getLineAndColumnAtPos(
					callExpr.getStart(),
				);
				if (isSingleRecord) {
					violations.push({
						filePath: displayPath,
						line,
						column,
						rule: "RULE_A_BARE_ID",
						message: `租户模型 ${modelName}.${methodName}() 的 where 缺少可静态证明的 organizationId / 复合组织键（禁止裸 id 或动态构造越权查询/改删；可改用 updateMany/deleteMany 或添加有效 // @org-scope-exempt: <理由>）`,
					});
				} else {
					violations.push({
						filePath: displayPath,
						line,
						column,
						rule: "RULE_B_USER_ONLY_OR_COMPAT",
						message: analysis.hasUserId
							? `共享账本模型 ${modelName}.${methodName}() 的 where 包含 userId 但缺少 organizationId（禁止退化成个人维度查询；如需例外请加 // @org-scope-exempt: <理由>）`
							: `共享账本模型 ${modelName}.${methodName}() 的 where 缺少可静态证明的 organizationId 过滤（禁止无组织隔离读/改/删；如需 post-lock/关联例外请加 // @org-scope-exempt: <理由>）`,
					});
				}
			}
		}
	}

	// 2. 规则 C（TaggedTemplateExpression 形态：$queryRaw`...` / $executeRaw`...`）
	if (!RAW_SQL_EXEMPT_FILENAMES.has(fileName)) {
		for (const tagged of sourceFile.getDescendantsOfKind(
			SyntaxKind.TaggedTemplateExpression,
		)) {
			const target = resolveCallTarget(tagged.getTag(), tagged);
			if (!target || target.kind !== "raw-sql") continue;

			const extracted = extractSqlFromTaggedTemplate(
				tagged,
				tagged,
				new Set<string>(),
			);
			checkRawSqlNode(
				tagged,
				target.methodName,
				extracted,
				sourceFile,
				displayPath,
				violations,
			);
		}
	}

	return violations;
}

function walkTargetFiles(
	rootDir: string,
	targetModules: readonly string[],
): string[] {
	const srcBase = resolve(rootDir, "services/chat/src");
	const files: string[] = [];

	const walkDir = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				walkDir(fullPath);
			} else if (
				entry.isFile() &&
				entry.name.endsWith(".ts") &&
				!entry.name.endsWith(".spec.ts") &&
				!entry.name.endsWith(".dto.ts") &&
				!entry.name.endsWith(".d.ts")
			) {
				files.push(fullPath);
			}
		}
	};

	for (const mod of targetModules) {
		walkDir(resolve(srcBase, mod));
	}
	return files.sort();
}

export function scanOrgScope(
	options: ScanOrgScopeOptions = {},
): ScanOrgScopeResult {
	const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const rootDir = resolve(options.rootDir ?? defaultRoot);
	const targetModules = options.targetModules ?? TARGET_MODULES;

	const project = new Project({
		useInMemoryFileSystem: true,
		skipAddingFilesFromTsConfig: true,
	});

	const violations: OrgScopeViolation[] = [];

	if (options.virtualFiles) {
		for (const vf of options.virtualFiles) {
			const sf = project.createSourceFile(vf.filePath, vf.content, {
				overwrite: true,
			});
			violations.push(...inspectSourceFile(sf, vf.filePath));
		}
		return { filesScanned: options.virtualFiles.length, violations };
	}

	const filePaths = walkTargetFiles(rootDir, targetModules);
	for (const absPath of filePaths) {
		const content = readFileSync(absPath, "utf8");
		const relPath = relative(rootDir, absPath).replace(/\\/g, "/");
		const sf = project.createSourceFile(absPath, content, { overwrite: true });
		violations.push(...inspectSourceFile(sf, relPath));
	}

	return { filesScanned: filePaths.length, violations };
}

export function parseCheckOrgScopeArgs(argv: readonly string[]): {
	rootDir?: string;
} {
	let rootDir: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if ((token === "--cwd" || token === "--root") && i + 1 < argv.length) {
			rootDir = argv[++i];
		} else if (token.startsWith("--cwd=")) {
			rootDir = token.slice("--cwd=".length);
		} else if (token.startsWith("--root=")) {
			rootDir = token.slice("--root=".length);
		}
	}
	return { rootDir };
}

export function runCheckOrgScope(argv: readonly string[]): number {
	const { rootDir } = parseCheckOrgScopeArgs(argv);
	const result = scanOrgScope({ rootDir });

	if (result.violations.length > 0) {
		console.error(
			`❌ [check-org-scope] 检出 ${result.violations.length} 处组织作用域越权风险（共扫描 ${result.filesScanned} 个文件）：`,
		);
		for (const v of result.violations) {
			console.error(
				`  - ${v.filePath}:${v.line}:${v.column} [${v.rule}] ${v.message}`,
			);
		}
		return 1;
	}

	console.log(
		`✅ [check-org-scope] 组织作用域静态防越权守卫通过（扫描 ${result.filesScanned} 个文件，0 违规）`,
	);
	return 0;
}

if (import.meta.main) {
	process.exitCode = runCheckOrgScope(process.argv.slice(2));
}
