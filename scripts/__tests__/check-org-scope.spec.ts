import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseCheckOrgScopeArgs,
	scanOrgScope,
} from "../check-org-scope";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/check-org-scope.ts");

function withTempWorkspace(
	files: Record<string, string>,
	fn: (rootDir: string) => void,
): void {
	const root = mkdtempSync(join(tmpdir(), "check-org-scope-test-"));
	try {
		for (const [relPath, content] of Object.entries(files)) {
			const abs = join(root, relPath);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, content, "utf8");
		}
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("check-org-scope static guard", () => {
	test("parseCheckOrgScopeArgs parses --cwd and --root flags", () => {
		expect(parseCheckOrgScopeArgs(["--cwd", "/tmp/demo"])).toEqual({
			rootDir: "/tmp/demo",
		});
		expect(parseCheckOrgScopeArgs(["--root=/tmp/other"])).toEqual({
			rootDir: "/tmp/other",
		});
		expect(parseCheckOrgScopeArgs([])).toEqual({ rootDir: undefined });
	});

	test("positive: scans current repository with 0 violations and CLI exits 0", () => {
		const result = scanOrgScope({ rootDir: REPO_ROOT });
		expect(result.filesScanned).toBeGreaterThan(0);
		expect(result.violations).toEqual([]);

		const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", REPO_ROOT], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		expect(cliRes.status).toBe(0);
		expect(cliRes.stdout).toContain("0 违规");
	});

	test("positive: allows org-scoped queries, compound org keys, (userId, organizationId) on aiConversation, personal models, and org-filtered raw SQL", () => {
		const result = scanOrgScope({
			virtualFiles: [
				{
					filePath: "services/chat/src/plan/good.service.ts",
					content: `
						export async function ok(prisma: any, id: string, organizationId: string, userId: string) {
							await prisma.plan.findUnique({ where: { id, organizationId } });
							await prisma.account.findUnique({ where: { organizationId_currencyCode: { organizationId, currencyCode: "USD" } } });
							await prisma.organizationSettings.findUnique({ where: { organizationId } });
							await prisma.plan.findMany({ where: { organizationId, status: "ACTIVE" } });
							await prisma.aiConversation.findMany({ where: { userId, organizationId } });
							await prisma.userSettings.findUnique({ where: { userId } });
							await prisma.termsConsent.findMany({ where: { userId } });
							await prisma.reminderRead.findMany({ where: { userId } });
							await prisma.dataRequest.findMany({ where: { userId, scope: "PERSONAL" } });
							await prisma.$queryRaw\`SELECT id FROM plans WHERE organization_id = \${organizationId}\`;
						}
					`,
				},
			],
		});
		expect(result.violations).toEqual([]);
	});

	test("negative #1: blocks bare id findUnique / update / delete on tenant models (RULE_A_BARE_ID) and CLI exits 1", () => {
		withTempWorkspace(
			{
				"services/chat/src/plan/bad-bare-id.service.ts": `
					export async function bad(prisma: any, id: string) {
						await prisma.plan.findUnique({ where: { id } });
						await prisma.aiConversation.delete({ where: { id } });
						await prisma.transaction.update({ where: { id }, data: { version: 2 } });
					}
				`,
			},
			(rootDir) => {
				const result = scanOrgScope({ rootDir });
				expect(result.violations).toHaveLength(3);
				expect(result.violations.every((v) => v.rule === "RULE_A_BARE_ID")).toBe(
					true,
				);

				const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", rootDir], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				expect(cliRes.status).toBe(1);
				expect(cliRes.stderr).toContain("RULE_A_BARE_ID");
			},
		);
	});

	test("negative #2: blocks userId-only queries and the removed compat fallback (organizationId: null) on shared ledger models (RULE_B_USER_ONLY_OR_COMPAT)", () => {
		withTempWorkspace(
			{
				"services/chat/src/plan/bad-user-only.service.ts": `
					export async function bad(prisma: any, userId: string, scope: any) {
						await prisma.plan.findMany({ where: { userId } });
						await prisma.account.findFirst({ where: { organizationId: null, userId } });
						await prisma.costLot.findMany({ where: { organizationId: null } });
					}
				`,
			},
			(rootDir) => {
				const result = scanOrgScope({ rootDir });
				expect(result.violations).toHaveLength(3);
				expect(
					result.violations.every(
						(v) => v.rule === "RULE_B_USER_ONLY_OR_COMPAT",
					),
				).toBe(true);

				const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", rootDir], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				expect(cliRes.status).toBe(1);
				expect(cliRes.stderr).toContain("RULE_B_USER_ONLY_OR_COMPAT");
			},
		);
	});

	test("positive #2b (W30): pure org-scope helpers (organizationLedgerScope / conversationOrgWhere) are NOT treated as transitional compat", () => {
		const result = scanOrgScope({
			virtualFiles: [
				{
					filePath: "services/chat/src/data-request/ok-pure-org-scope.service.ts",
					content: `
						export async function ok(prisma: any, tx: any, organizationId: string, userId: string, scope: any) {
							await prisma.plan.findMany({ where: { ...organizationLedgerScope(organizationId) } });
							await prisma.aiConversation.findMany({ where: { AND: [{ userId }, conversationOrgWhere(scope)] } });
						}
					`,
				},
			],
		});
		expect(result.violations).toEqual([]);
	});

	test("negative #3: blocks aiConversation query with userId but missing organizationId", () => {
		withTempWorkspace(
			{
				"services/chat/src/ai/bad-ai.service.ts": `
					export async function badAi(prisma: any, userId: string) {
						return prisma.aiConversation.findMany({ where: { userId } });
					}
				`,
			},
			(rootDir) => {
				const result = scanOrgScope({ rootDir });
				expect(result.violations).toHaveLength(1);
				expect(result.violations[0].rule).toBe("RULE_B_USER_ONLY_OR_COMPAT");

				const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", rootDir], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				expect(cliRes.status).toBe(1);
			},
		);
	});

	test("negative #4: rejects empty @org-scope-exempt reason and does not exempt the violation", () => {
		withTempWorkspace(
			{
				"services/chat/src/usage/bad-empty-exempt.service.ts": `
					export async function badExempt(prisma: any, id: string) {
						// @org-scope-exempt:
						await prisma.plan.findUnique({ where: { id } });
						// @org-scope-exempt
						await prisma.costLot.update({ where: { id }, data: { remainingQty: 0 } });
					}
				`,
			},
			(rootDir) => {
				const result = scanOrgScope({ rootDir });
				const rules = result.violations.map((v) => v.rule);
				expect(rules).toContain("EMPTY_EXEMPT_REASON");
				expect(rules).toContain("RULE_A_BARE_ID");
				expect(result.violations.length).toBeGreaterThanOrEqual(4);

				const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", rootDir], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				expect(cliRes.status).toBe(1);
				expect(cliRes.stderr).toContain("EMPTY_EXEMPT_REASON");
			},
		);
	});

	test("negative #5: blocks raw SQL ($queryRaw / $executeRaw) touching tenant table without organization_id", () => {
		withTempWorkspace(
			{
				"services/chat/src/home/bad-raw.service.ts": `
					export async function badRaw(prisma: any, id: string) {
						await prisma.$queryRaw\`SELECT id FROM plans WHERE id = \${id}\`;
						await prisma.$executeRawUnsafe("UPDATE cost_lots SET remaining_qty = 0");
					}
				`,
			},
			(rootDir) => {
				const result = scanOrgScope({ rootDir });
				expect(result.violations).toHaveLength(2);
				expect(
					result.violations.every((v) => v.rule === "RULE_C_RAW_SQL_NO_ORG"),
				).toBe(true);

				const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", rootDir], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				expect(cliRes.status).toBe(1);
				expect(cliRes.stderr).toContain("RULE_C_RAW_SQL_NO_ORG");
			},
		);
	});

	test("positive #6: allows explicit non-empty @org-scope-exempt annotation and CLI exits 0", () => {
		withTempWorkspace(
			{
				"services/chat/src/usage/exempt-ok.service.ts": `
					export async function okExempt(prisma: any, id: string, userId: string) {
						// @org-scope-exempt: verified org ownership via lock
						await prisma.plan.findUnique({ where: { id } });
						// @org-scope-exempt: 已由组织账本行锁校验归属，仅按主键回读
						await prisma.plan.findMany({ where: { userId } });
						// @org-scope-exempt: 历史汇总脚本全库只读核对
						await prisma.$queryRaw\`SELECT count(*) FROM plans\`;
					}
				`,
			},
			(rootDir) => {
				const result = scanOrgScope({ rootDir });
				expect(result.violations).toEqual([]);

				const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", rootDir], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				expect(cliRes.status).toBe(0);
			},
		);
	});

	test("negative #7 (Important #1 & #2): blocks updateMany / deleteMany / findFirst / findFirstOrThrow / upsert without organizationId and aiConversation.deleteMany({ id })", () => {
		withTempWorkspace(
			{
				"services/chat/src/plan/bad-bulk-and-upsert.service.ts": `
					export async function badBulk(prisma: any, id: string, planId: string) {
						await prisma.plan.updateMany({ where: { id }, data: { status: "CANCELLED" } });
						await prisma.plan.deleteMany({ where: { id } });
						await prisma.plan.findFirst({ where: { id } });
						await prisma.plan.findFirstOrThrow({ where: { id } });
						await prisma.plan.upsert({ where: { id }, create: {}, update: {} });
						await prisma.planChangeLog.findMany({ where: { planId } });
						await prisma.aiConversation.deleteMany({ where: { id } });
					}
				`,
			},
			(rootDir) => {
				const result = scanOrgScope({ rootDir });
				expect(result.violations).toHaveLength(7);

				const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", rootDir], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				expect(cliRes.status).toBe(1);
			},
		);
	});

	test("negative #8 (Important #3): blocks bracket access, cast wrappers, delegate aliasing/destructuring, and dynamic model subscripting", () => {
		withTempWorkspace(
			{
				"services/chat/src/plan/bad-aliasing.service.ts": `
					export async function badAlias(prisma: any, tx: any, id: string, dynModel: string) {
						await prisma["plan"]["findUnique"]({ where: { id } });
						await (prisma as any).plan.findUnique({ where: { id } });
						await (prisma satisfies any).plan.findFirst({ where: { id } });
						const repo = prisma.plan;
						await repo.findUnique({ where: { id } });
						const { plan } = prisma;
						await plan.deleteMany({ where: { id } });
						await tx[dynModel].findMany({ where: { id } });
					}
				`,
			},
			(rootDir) => {
				const result = scanOrgScope({ rootDir });
				expect(result.violations).toHaveLength(6);

				const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", rootDir], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				expect(cliRes.status).toBe(1);
			},
		);
	});

	test("negative #9 (Important #4): blocks OR / ternary / NOT / undefined / Object.assign / mutated let / unwhitelisted builder bypasses", () => {
		withTempWorkspace(
			{
				"services/chat/src/plan/bad-where-bypasses.service.ts": `
					function buildWhere(id: string) { return { id }; }
					export async function badWhere(prisma: any, id: string, organizationId: string, userId: string, cond: boolean, extra: any) {
						await prisma.plan.findMany({ where: { OR: [{ organizationId }, { id }] } });
						await prisma.plan.findMany({ where: cond ? { organizationId } : { id } });
						await prisma.plan.findMany({ where: { NOT: { organizationId } } });
						await prisma.plan.findMany({ where: { organizationId: undefined, id } });
						await prisma.plan.findMany({ where: { organizationId: void 0, id } });
						await prisma.plan.findMany({ where: Object.assign({ organizationId }, extra) });
						await prisma.plan.findMany({ where: buildWhere(id) });
						let w: any = { organizationId };
						w.userId = userId;
						await prisma.plan.findMany({ where: w });
					}
				`,
			},
			(rootDir) => {
				const result = scanOrgScope({ rootDir });
				expect(result.violations).toHaveLength(8);

				const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", rootDir], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				expect(cliRes.status).toBe(1);
			},
		);
	});

	test("negative #10 (Important #5): blocks Prisma.sql, SQL comment bypass, SELECT-only organization_id, and dynamic/aliased raw SQL", () => {
		withTempWorkspace(
			{
				"services/chat/src/home/bad-raw-bypasses.service.ts": `
					declare const Prisma: any;
					function makeSql() { return "SELECT * FROM plans"; }
					export async function badRawBypasses(prisma: any, id: string, orgId: string) {
						await prisma.$queryRaw(Prisma.sql\`SELECT id FROM plans WHERE id = \${id}\`);
						await prisma.$queryRaw\`SELECT id FROM plans /* WHERE organization_id = \${orgId} */ WHERE id = \${id}\`;
						await prisma.$queryRaw\`SELECT organization_id FROM plans WHERE id = \${id}\`;
						const execRaw = prisma.$queryRawUnsafe;
						await execRaw("SELECT * FROM plans WHERE id = " + id);
						await prisma.$queryRawUnsafe(makeSql());
					}
				`,
			},
			(rootDir) => {
				const result = scanOrgScope({ rootDir });
				expect(result.violations).toHaveLength(5);
				expect(
					result.violations.every((v) => v.rule === "RULE_C_RAW_SQL_NO_ORG"),
				).toBe(true);

				const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", rootDir], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				expect(cliRes.status).toBe(1);
			},
		);
	});

	test("negative #11 (Nit): blocks Promise.all outer comment inheritance, blank-line separated comments, and trivial placeholder reasons", () => {
		withTempWorkspace(
			{
				"services/chat/src/usage/bad-exempt-nit.service.ts": `
					export async function badExemptScope(prisma: any, id: string) {
						// @org-scope-exempt: outer comment should not exempt Promise.all inner calls
						await Promise.all([
							prisma.plan.findUnique({ where: { id } }),
							prisma.account.findFirst({ where: { id } }),
						]);

						// @org-scope-exempt: blank line breaks adjacency below

						await prisma.plan.findUnique({ where: { id } });

						// @org-scope-exempt: TODO
						await prisma.plan.findUnique({ where: { id } });
						// @org-scope-exempt: temp
						await prisma.plan.findUnique({ where: { id } });
						// @org-scope-exempt: 123
						await prisma.plan.findUnique({ where: { id } });
					}
				`,
			},
			(rootDir) => {
				const result = scanOrgScope({ rootDir });
				const emptyReasons = result.violations.filter(
					(v) => v.rule === "EMPTY_EXEMPT_REASON",
				);
				const ruleViolations = result.violations.filter(
					(v) => v.rule !== "EMPTY_EXEMPT_REASON",
				);
				expect(emptyReasons).toHaveLength(3);
				expect(ruleViolations).toHaveLength(6);

				const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", rootDir], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				expect(cliRes.status).toBe(1);
			},
		);
	});

	test("negative #12 (W30): blocks mutated let, uninitialized variable, or cast/shadowed OrganizationLedgerScope bypasses", () => {
		withTempWorkspace(
			{
				"services/chat/src/data-request/bad-type-bypass.service.ts": `
					type OrganizationLedgerScope = { userId: string };
					export async function badTypeBypass(
						prisma: any,
						id: string,
						organizationId: string,
						userId: string,
					) {
						let mutableScope: OrganizationLedgerScope = { organizationId } as any;
						mutableScope = { userId };
						await prisma.plan.findMany({ where: mutableScope });

						let uninitializedScope: OrganizationLedgerScope;
						uninitializedScope = { id } as any;
						await prisma.plan.findUnique({ where: uninitializedScope });

						const castScope = ({ userId } as unknown) as OrganizationLedgerScope;
						await prisma.account.findMany({ where: castScope });

						const shadowedScope: OrganizationLedgerScope = { userId };
						await prisma.transaction.findMany({ where: shadowedScope });
					}
				`,
			},
			(rootDir) => {
				const result = scanOrgScope({ rootDir });
				expect(result.violations).toHaveLength(4);
				expect(
					result.violations.every(
						(v) =>
							v.rule === "RULE_A_BARE_ID" ||
							v.rule === "RULE_B_USER_ONLY_OR_COMPAT",
					),
				).toBe(true);

				const cliRes = spawnSync("bun", ["run", SCRIPT_PATH, "--cwd", rootDir], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				expect(cliRes.status).toBe(1);
			},
		);
	});
});
