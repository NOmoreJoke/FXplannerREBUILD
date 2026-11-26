/**
 * Goal #3C W30 §14.5 性能回归与 EXPLAIN (ANALYZE, BUFFERS) 实测脚本（P6）。
 *
 * 职责与纪律：
 * - 仅允许连接本机回环 PostgreSQL 测试库（localhost / 127.0.0.1 / [::1]，
 *   拒绝 `?host=` 覆盖，拒绝 `fxplanner_prod` 与 `NODE_ENV=production`，库名必须以 `_test` 结尾）；
 * - 不依赖 Prisma Client 新生成模型字段：先通过 `information_schema.columns` 与 `pg_indexes`
 *   探测库阶段（pre-MIG-E/F / post-MIG-E / post-MIG-F），全部读写使用原生 SQL；
 * - 使用隔离前缀（`bench_p6_<ts>_<rand>`）造数（默认 120 组织 × 10 行/表 ≥ 1,200 账本行），
 *   执行 `ANALYZE` 后对 8 条核心租户查询运行 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`，
 *   断言全部命中 `organization_id` 打头索引且 0 `Seq Scan`；
 * - 预热后每条查询实测 ≥100 次迭代，计算 P50 / P95 耗时（ms），并支持 `--compare <baseline.json>`
 *   对比迁移前后延迟变化；
 * - `finally` 内 100% 清理本次造数并校验各表前后行数完全一致（零残留）；
 * - **严禁**把任何输出 JSON / 日志写入仓库目录（`--out` 指向仓库内路径直接报错退出）。
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@prisma/client";

const DEFAULT_ORGS = 120;
const DEFAULT_ROWS_PER_ORG = 10;
const DEFAULT_WARMUP = 20;
const DEFAULT_ITERATIONS = 100;

const CURRENCY_POOL = [
	"USD",
	"EUR",
	"GBP",
	"JPY",
	"HKD",
	"SGD",
	"AUD",
	"CAD",
	"CHF",
	"NZD",
	"KRW",
	"THB",
] as const;

const TRACKED_TABLES = [
	"users",
	"organizations",
	"memberships",
	"accounts",
	"plans",
	"plan_allocations",
	"transactions",
	"cost_lots",
	"usage_records",
	"corrections",
	"reminders",
	"audit_logs",
] as const;

type TrackedTable = (typeof TRACKED_TABLES)[number];

const BENCHMARK_TABLES = [
	"memberships",
	"accounts",
	"plans",
	"transactions",
	"usage_records",
	"corrections",
	"reminders",
	"audit_logs",
] as const;

type BenchmarkTable = (typeof BENCHMARK_TABLES)[number];

const USER_ID_PROBE_TABLES = [
	"accounts",
	"plans",
	"transactions",
	"cost_lots",
	"usage_records",
	"corrections",
	"reminders",
] as const;

const CREATED_BY_PROBE_TABLES = [
	"accounts",
	"plans",
	"transactions",
	"usage_records",
] as const;

interface CliOptions {
	outPath: string | null;
	comparePath: string | null;
	orgs: number;
	rowsPerOrg: number;
	warmup: number;
	iterations: number;
}

interface SchemaCapabilities {
	stage: "pre-mig-ef" | "post-mig-e" | "post-mig-f";
	tablesWithUserId: string[];
	tablesWithCreatedById: string[];
	hasCorrectionActorUserId: boolean;
	hasReminderReadAt: boolean;
	orgIdNullableByTable: Record<string, boolean>;
	orgLeadingIndexesByTable: Record<string, string[]>;
}

interface ExplainNode {
	"Node Type"?: string;
	"Relation Name"?: string;
	"Index Name"?: string;
	"Startup Cost"?: number;
	"Total Cost"?: number;
	"Actual Startup Time"?: number;
	"Actual Total Time"?: number;
	"Actual Rows"?: number;
	"Shared Hit Blocks"?: number;
	"Shared Read Blocks"?: number;
	Plans?: ExplainNode[];
}

interface ExplainScanHit {
	nodeType: string;
	relationName: string | null;
	indexName: string | null;
	isOrgLeadingIndex: boolean;
	actualTotalTimeMs: number | null;
	actualRows: number | null;
}

interface LatencyStats {
	iterations: number;
	warmup: number;
	minMs: number;
	meanMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
	avgRowsReturned: number;
}

interface QueryBenchmarkResult {
	key: string;
	table: BenchmarkTable;
	description: string;
	expectedIndexPrefix: string;
	explain: {
		nodeTypes: string[];
		seqScanCount: number;
		indexScans: ExplainScanHit[];
		orgLeadingIndexUsed: boolean;
		executionTimeMs: number | null;
		planningTimeMs: number | null;
		planRoot: ExplainNode;
	};
	latency: LatencyStats;
}

interface BaselineComparisonEntry {
	key: string;
	baselineP50Ms: number;
	currentP50Ms: number;
	deltaP50Ms: number;
	baselineP95Ms: number;
	currentP95Ms: number;
	deltaP95Ms: number;
}

interface BenchmarkReport {
	generatedAt: string;
	database: string;
	runPrefix: string;
	config: {
		orgs: number;
		rowsPerOrg: number;
		warmup: number;
		iterations: number;
	};
	schemaCapabilities: SchemaCapabilities;
	seededCounts: Record<TrackedTable, number>;
	beforeCounts: Record<TrackedTable, number>;
	afterCounts: Record<TrackedTable, number>;
	zeroResidueVerified: boolean;
	queries: QueryBenchmarkResult[];
	assertions: {
		allQueriesZeroSeqScan: boolean;
		allQueriesUsedOrgLeadingIndex: boolean;
		zeroResidue: boolean;
	};
	comparison?: {
		baselineFile: string;
		baselineStage: string | null;
		currentStage: string;
		entries: BaselineComparisonEntry[];
	};
}

const USAGE = `用法（在 services/chat 下运行，DATABASE_URL 必须指向本机 *_test 测试库）：
  bun prisma/tob-r1-migration/benchmark-p6.ts [--out /tmp/w30_perf_results.json]
  bun prisma/tob-r1-migration/benchmark-p6.ts --out /tmp/w30_perf_results.json --compare /tmp/w30_perf_pre.json

选项：
  --out <path>          将 JSON 结果写入仓库外路径（禁止写入仓库内部）
  --compare <path>      可选：读取基线 JSON（如 /tmp/w30_perf_pre.json）对比 P50/P95 变化
  --orgs <n>            造数企业组织数量（默认 ${DEFAULT_ORGS}，要求 >= 105）
  --rows-per-org <n>    每个组织在各业务表的行数（默认 ${DEFAULT_ROWS_PER_ORG}，要求 >= 10）
  --warmup <n>          每条查询预热次数（默认 ${DEFAULT_WARMUP}，要求 >= 10）
  --iterations <n>      每条查询实测迭代次数（默认 ${DEFAULT_ITERATIONS}，要求 >= 100）`;

function parsePositiveIntFlag(flag: string, raw: string, min: number): number {
	if (!/^\d+$/.test(raw)) {
		throw new Error(`${flag} 必须为正整数，收到: ${raw}`);
	}
	const val = Number.parseInt(raw, 10);
	if (val < min) {
		throw new Error(`${flag} 不能小于 ${min}，收到: ${val}`);
	}
	return val;
}

function parseArgs(argv: readonly string[]): CliOptions {
	let outPath: string | null = null;
	let comparePath: string | null = null;
	let orgs = DEFAULT_ORGS;
	let rowsPerOrg = DEFAULT_ROWS_PER_ORG;
	let warmup = DEFAULT_WARMUP;
	let iterations = DEFAULT_ITERATIONS;

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === "--help" || token === "-h") {
			console.error(USAGE);
			process.exit(0);
		}
		const eqIdx = token.indexOf("=");
		const flag = eqIdx >= 0 ? token.slice(0, eqIdx) : token;
		const inlineVal = eqIdx >= 0 ? token.slice(eqIdx + 1) : null;

		const readValue = (): string => {
			if (inlineVal !== null) return inlineVal;
			if (i + 1 >= argv.length) {
				throw new Error(`旗标 ${flag} 缺少参数值\n${USAGE}`);
			}
			i += 1;
			return argv[i];
		};

		if (flag === "--out") {
			outPath = readValue();
		} else if (flag === "--compare") {
			comparePath = readValue();
		} else if (flag === "--orgs") {
			orgs = parsePositiveIntFlag(flag, readValue(), 105);
		} else if (flag === "--rows-per-org") {
			rowsPerOrg = parsePositiveIntFlag(flag, readValue(), 10);
		} else if (flag === "--warmup") {
			warmup = parsePositiveIntFlag(flag, readValue(), 10);
		} else if (flag === "--iterations") {
			iterations = parsePositiveIntFlag(flag, readValue(), 100);
		} else {
			throw new Error(`未知参数: ${token}\n${USAGE}`);
		}
	}

	return {
		outPath,
		comparePath,
		orgs,
		rowsPerOrg,
		warmup,
		iterations,
	};
}

function getRepoRoot(): string {
	return path.resolve(__dirname, "../../../..");
}

function isWithinBase(candidate: string, base: string): boolean {
	const rel = path.relative(base, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isPathInsideDir(targetPath: string, dirPath: string): boolean {
	const lexicalTarget = path.resolve(targetPath);
	const lexicalDir = path.resolve(dirPath);
	if (isWithinBase(lexicalTarget, lexicalDir)) {
		return true;
	}
	const realDir = fs.existsSync(lexicalDir)
		? fs.realpathSync(lexicalDir)
		: lexicalDir;
	const targetParent = path.dirname(lexicalTarget);
	const realTargetParent = fs.existsSync(targetParent)
		? fs.realpathSync(targetParent)
		: targetParent;
	const realTarget = path.join(realTargetParent, path.basename(lexicalTarget));
	return isWithinBase(realTarget, realDir);
}

function assertSafeOutputPath(outPath: string, repoRoot: string): string {
	const resolved = path.resolve(outPath);
	if (isPathInsideDir(resolved, repoRoot)) {
		throw new Error(
			`禁止将基准输出写入仓库目录内（${resolved}）；请输出到 /tmp/ 或仓库之外的路径。`,
		);
	}
	return resolved;
}

function assertSafeLocalTestDatabase(
	databaseUrl: string | undefined,
	nodeEnv: string | undefined,
): string {
	if (nodeEnv === "production") {
		throw new Error("安全拦截：NODE_ENV=production 下禁止运行性能压测脚本");
	}
	if (!databaseUrl) {
		throw new Error("缺少 DATABASE_URL 环境变量");
	}
	let parsed: URL;
	try {
		parsed = new URL(databaseUrl);
	} catch {
		throw new Error("DATABASE_URL 格式非法，无法解析为 URL");
	}
	if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
		throw new Error(
			`仅支持 postgresql:/postgres: 协议（收到 ${parsed.protocol}）`,
		);
	}
	if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
		throw new Error(
			`安全拦截：仅允许回环主机（localhost / 127.0.0.1 / [::1]），收到 ${parsed.hostname}`,
		);
	}
	const hasHostOverride = [...parsed.searchParams.keys()].some(
		(key) => key.toLowerCase() === "host",
	);
	if (hasHostOverride) {
		throw new Error(
			"安全拦截：禁止在 DATABASE_URL 中使用 ?host= 覆写目标主机",
		);
	}
	const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
	if (!dbName || /fxplanner_prod/i.test(dbName)) {
		throw new Error(`安全拦截：拒绝生产库或空库名（${dbName || "空"}）`);
	}
	// 库名必须以 _test 结尾，不设环境变量旁路：本脚本会写入并删除上万行，
	// 迁移演练用的备份副本库（如 fxplanner_new_db_migbak）不是基准的目标
	if (!dbName.endsWith("_test")) {
		throw new Error(
			`安全拦截：仅允许以 _test 结尾的本地测试库（收到 ${dbName}）`,
		);
	}
	return dbName;
}

async function detectCapabilities(
	prisma: PrismaClient,
): Promise<SchemaCapabilities> {
	const allProbeTables = [...new Set([...BENCHMARK_TABLES, ...USER_ID_PROBE_TABLES])];
	const cols = await prisma.$queryRaw<
		Array<{ tableName: string; columnName: string; isNullable: string }>
	>`
		SELECT
			table_name AS "tableName",
			column_name AS "columnName",
			is_nullable AS "isNullable"
		FROM information_schema.columns
		WHERE table_schema = current_schema()
			AND table_name = ANY(${allProbeTables}::text[])
			AND column_name = ANY(${["user_id", "organization_id", "created_by_id", "actor_user_id", "read_at"]}::text[])
	`;

	const tablesWithUserId = new Set<string>();
	const tablesWithCreatedById = new Set<string>();
	let hasCorrectionActorUserId = false;
	let hasReminderReadAt = false;
	const orgIdNullableByTable: Record<string, boolean> = {};

	for (const row of cols) {
		if (row.columnName === "user_id") {
			if ((USER_ID_PROBE_TABLES as readonly string[]).includes(row.tableName)) {
				tablesWithUserId.add(row.tableName);
			}
		} else if (row.columnName === "created_by_id") {
			if (
				(CREATED_BY_PROBE_TABLES as readonly string[]).includes(row.tableName)
			) {
				tablesWithCreatedById.add(row.tableName);
			}
		} else if (
			row.tableName === "corrections" &&
			row.columnName === "actor_user_id"
		) {
			hasCorrectionActorUserId = true;
		} else if (row.tableName === "reminders" && row.columnName === "read_at") {
			hasReminderReadAt = true;
		} else if (row.columnName === "organization_id") {
			orgIdNullableByTable[row.tableName] = row.isNullable === "YES";
		}
	}

	const idxRows = await prisma.$queryRaw<
		Array<{ tablename: string; indexname: string; indexdef: string }>
	>`
		SELECT tablename, indexname, indexdef
		FROM pg_indexes
		WHERE schemaname = current_schema()
			AND tablename = ANY(${[...BENCHMARK_TABLES]}::text[])
		ORDER BY tablename, indexname
	`;

	const orgLeadingIndexesByTable: Record<string, string[]> = {};
	for (const table of BENCHMARK_TABLES) {
		orgLeadingIndexesByTable[table] = [];
	}
	for (const row of idxRows) {
		// 匹配 USING btree (organization_id ...
		if (/USING\s+\w+\s*\(\s*"?organization_id"?\b/i.test(row.indexdef)) {
			orgLeadingIndexesByTable[row.tablename].push(row.indexname);
		}
	}

	let stage: SchemaCapabilities["stage"] = "pre-mig-ef";
	if (!tablesWithUserId.has("accounts")) {
		stage = "post-mig-f";
	} else if (orgIdNullableByTable.accounts === false) {
		stage = "post-mig-e";
	}

	return {
		stage,
		tablesWithUserId: [...tablesWithUserId].sort(),
		tablesWithCreatedById: [...tablesWithCreatedById].sort(),
		hasCorrectionActorUserId,
		hasReminderReadAt,
		orgIdNullableByTable,
		orgLeadingIndexesByTable,
	};
}

async function collectTableCounts(
	prisma: PrismaClient,
): Promise<Record<TrackedTable, number>> {
	const counts = {} as Record<TrackedTable, number>;
	for (const table of TRACKED_TABLES) {
		const rows = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(
			`SELECT count(*)::int AS cnt FROM "${table}"`,
		);
		counts[table] = rows[0]?.cnt ?? 0;
	}
	return counts;
}

interface SeedDataset {
	orgIds: string[];
	userIdsByOrg: string[];
	planIdsByOrg: string[];
	txIdsByOrg: string[];
	currencies: string[];
	minWindowDate: Date;
	counts: Record<TrackedTable, number>;
}

async function seedIsolatedData(
	prisma: PrismaClient,
	runPrefix: string,
	orgs: number,
	rowsPerOrg: number,
	caps: SchemaCapabilities,
): Promise<SeedDataset> {
	const userIdSet = new Set(caps.tablesWithUserId);
	const createdBySet = new Set(caps.tablesWithCreatedById);

	const userIds: string[] = [];
	const userEmails: string[] = [];
	const userNames: string[] = [];
	const orgIds: string[] = [];
	const orgNames: string[] = [];

	const userCount = Math.max(orgs, rowsPerOrg);
	for (let u = 0; u < userCount; u += 1) {
		const suffix = String(u).padStart(4, "0");
		userIds.push(`${runPrefix}_usr_${suffix}`);
		userEmails.push(`${runPrefix}_u_${suffix}@bench.invalid`);
		userNames.push(`Bench User ${suffix}`);
	}
	for (let o = 0; o < orgs; o += 1) {
		const suffix = String(o).padStart(4, "0");
		orgIds.push(`${runPrefix}_org_${suffix}`);
		orgNames.push(`Bench Org ${suffix}`);
	}

	await prisma.$executeRaw`
		INSERT INTO users (id, email, name, created_at, updated_at)
		SELECT id, email, name, NOW(), NOW()
		FROM UNNEST(${userIds}::text[], ${userEmails}::text[], ${userNames}::text[])
			AS t(id, email, name)
	`;

	await prisma.$executeRaw`
		INSERT INTO organizations (id, name, created_at, updated_at)
		SELECT id, name, NOW(), NOW()
		FROM UNNEST(${orgIds}::text[], ${orgNames}::text[])
			AS t(id, name)
	`;

	// Memberships: orgs * rowsPerOrg rows; m === 0 is OWNER, m > 0 is VIEWER
	const memIds: string[] = [];
	const memOrgIds: string[] = [];
	const memUserIds: string[] = [];
	const memRoles: string[] = [];

	for (let o = 0; o < orgs; o += 1) {
		for (let m = 0; m < rowsPerOrg; m += 1) {
			const idx = o * rowsPerOrg + m;
			memIds.push(`${runPrefix}_mem_${String(idx).padStart(6, "0")}`);
			memOrgIds.push(orgIds[o]);
			memUserIds.push(userIds[(o + m) % userCount]);
			memRoles.push(m === 0 ? "OWNER" : "VIEWER");
		}
	}

	await prisma.$executeRaw`
		INSERT INTO memberships (id, organization_id, user_id, role, status, joined_at, created_at, updated_at)
		SELECT id, org_id, usr_id, role, 'ACTIVE', NOW(), NOW(), NOW()
		FROM UNNEST(${memIds}::text[], ${memOrgIds}::text[], ${memUserIds}::text[], ${memRoles}::text[])
			AS t(id, org_id, usr_id, role)
	`;

	// Build currency list of length rowsPerOrg
	const currencies: string[] = [];
	for (let m = 0; m < rowsPerOrg; m += 1) {
		currencies.push(
			m < CURRENCY_POOL.length ? CURRENCY_POOL[m] : `B${String(m).padStart(2, "0")}`,
		);
	}

	const baseTimeMs = Date.UTC(2026, 10, 1, 0, 0, 0);
	const minWindowDate = new Date(baseTimeMs);

	const accIds: string[] = [];
	const accOrgIds: string[] = [];
	const accUserIds: string[] = [];
	const accCurrencies: string[] = [];

	const planIds: string[] = [];
	const planOrgIds: string[] = [];
	const planUserIds: string[] = [];
	const planStatuses: string[] = [];
	const planAllocIds: string[] = [];

	const txIds: string[] = [];
	const txOrgIds: string[] = [];
	const txUserIds: string[] = [];
	const txPlanIds: string[] = [];
	const txTimes: Date[] = [];

	const lotIds: string[] = [];

	const usageIds: string[] = [];
	const usageOrgIds: string[] = [];
	const usageUserIds: string[] = [];
	const usagePlanIds: string[] = [];
	const usageTimes: Date[] = [];

	const corrIds: string[] = [];
	const corrOrgIds: string[] = [];
	const corrUserIds: string[] = [];
	const corrTargetIds: string[] = [];

	const remIds: string[] = [];
	const remOrgIds: string[] = [];
	const remUserIds: string[] = [];
	const remPlanIds: string[] = [];
	const remDedupKeys: string[] = [];
	const remTimes: Date[] = [];

	const auditIds: string[] = [];
	const auditOrgIds: string[] = [];
	const auditActorIds: string[] = [];
	const auditTargetIds: string[] = [];
	const auditTimes: Date[] = [];

	for (let o = 0; o < orgs; o += 1) {
		const orgId = orgIds[o];
		const ownerId = userIds[o];
		for (let m = 0; m < rowsPerOrg; m += 1) {
			const idx = o * rowsPerOrg + m;
			const pad = String(idx).padStart(6, "0");
			const rowTime = new Date(baseTimeMs + idx * 60_000);

			accIds.push(`${runPrefix}_acc_${pad}`);
			accOrgIds.push(orgId);
			accUserIds.push(ownerId);
			accCurrencies.push(currencies[m]);

			const pId = `${runPrefix}_pln_${pad}`;
			planIds.push(pId);
			planOrgIds.push(orgId);
			planUserIds.push(ownerId);
			planStatuses.push(m % 2 === 0 ? "ACTIVE" : "COMPLETED");
			planAllocIds.push(`${runPrefix}_pal_${pad}`);

			const tId = `${runPrefix}_tx_${pad}`;
			txIds.push(tId);
			txOrgIds.push(orgId);
			txUserIds.push(ownerId);
			txPlanIds.push(pId);
			txTimes.push(rowTime);

			lotIds.push(`${runPrefix}_lot_${pad}`);

			usageIds.push(`${runPrefix}_usg_${pad}`);
			usageOrgIds.push(orgId);
			usageUserIds.push(ownerId);
			usagePlanIds.push(pId);
			usageTimes.push(rowTime);

			corrIds.push(`${runPrefix}_cor_${pad}`);
			corrOrgIds.push(orgId);
			corrUserIds.push(ownerId);
			corrTargetIds.push(txIds[o * rowsPerOrg]);

			remIds.push(`${runPrefix}_rem_${pad}`);
			remOrgIds.push(orgId);
			remUserIds.push(ownerId);
			remPlanIds.push(pId);
			remDedupKeys.push(`${runPrefix}_dk_${pad}`);
			remTimes.push(rowTime);

			auditIds.push(`${runPrefix}_aud_${pad}`);
			auditOrgIds.push(orgId);
			auditActorIds.push(ownerId);
			auditTargetIds.push(tId);
			auditTimes.push(rowTime);
		}
	}

	// 4. accounts (probe user_id & created_by_id)
	if (userIdSet.has("accounts") && createdBySet.has("accounts")) {
		await prisma.$executeRaw`
			INSERT INTO accounts (id, user_id, organization_id, created_by_id, currency_code, balance, created_at, updated_at)
			SELECT id, usr_id, org_id, usr_id, curr, 10000.0000::decimal(20,4), NOW(), NOW()
			FROM UNNEST(${accIds}::text[], ${accUserIds}::text[], ${accOrgIds}::text[], ${accCurrencies}::text[])
				AS t(id, usr_id, org_id, curr)
		`;
	} else if (createdBySet.has("accounts")) {
		await prisma.$executeRaw`
			INSERT INTO accounts (id, organization_id, created_by_id, currency_code, balance, created_at, updated_at)
			SELECT id, org_id, usr_id, curr, 10000.0000::decimal(20,4), NOW(), NOW()
			FROM UNNEST(${accIds}::text[], ${accOrgIds}::text[], ${accUserIds}::text[], ${accCurrencies}::text[])
				AS t(id, org_id, usr_id, curr)
		`;
	} else {
		await prisma.$executeRaw`
			INSERT INTO accounts (id, organization_id, currency_code, balance, created_at, updated_at)
			SELECT id, org_id, curr, 10000.0000::decimal(20,4), NOW(), NOW()
			FROM UNNEST(${accIds}::text[], ${accOrgIds}::text[], ${accCurrencies}::text[])
				AS t(id, org_id, curr)
		`;
	}

	// 5. plans
	if (userIdSet.has("plans") && createdBySet.has("plans")) {
		await prisma.$executeRaw`
			INSERT INTO plans (id, user_id, organization_id, created_by_id, name, pace_preference, target_currency, target_amount, expect_use_date, prep_lead_days, latest_prep_date, status, created_at, updated_at)
			SELECT id, usr_id, org_id, usr_id, id, 'balanced', 'USD', 5000.0000::decimal(20,4), NOW() + INTERVAL '30 days', 3, NOW() + INTERVAL '27 days', status, NOW(), NOW()
			FROM UNNEST(${planIds}::text[], ${planUserIds}::text[], ${planOrgIds}::text[], ${planStatuses}::text[])
				AS t(id, usr_id, org_id, status)
		`;
	} else if (createdBySet.has("plans")) {
		await prisma.$executeRaw`
			INSERT INTO plans (id, organization_id, created_by_id, name, pace_preference, target_currency, target_amount, expect_use_date, prep_lead_days, latest_prep_date, status, created_at, updated_at)
			SELECT id, org_id, usr_id, id, 'balanced', 'USD', 5000.0000::decimal(20,4), NOW() + INTERVAL '30 days', 3, NOW() + INTERVAL '27 days', status, NOW(), NOW()
			FROM UNNEST(${planIds}::text[], ${planOrgIds}::text[], ${planUserIds}::text[], ${planStatuses}::text[])
				AS t(id, org_id, usr_id, status)
		`;
	} else {
		await prisma.$executeRaw`
			INSERT INTO plans (id, organization_id, name, pace_preference, target_currency, target_amount, expect_use_date, prep_lead_days, latest_prep_date, status, created_at, updated_at)
			SELECT id, org_id, id, 'balanced', 'USD', 5000.0000::decimal(20,4), NOW() + INTERVAL '30 days', 3, NOW() + INTERVAL '27 days', status, NOW(), NOW()
			FROM UNNEST(${planIds}::text[], ${planOrgIds}::text[], ${planStatuses}::text[])
				AS t(id, org_id, status)
		`;
	}

	// 6. plan_allocations
	await prisma.$executeRaw`
		INSERT INTO plan_allocations (id, plan_id, amount, used_amount, created_at, updated_at)
		SELECT id, plan_id, 1000.0000::decimal(20,4), 100.0000::decimal(20,4), NOW(), NOW()
		FROM UNNEST(${planAllocIds}::text[], ${planIds}::text[])
			AS t(id, plan_id)
	`;

	// 7. transactions
	if (userIdSet.has("transactions") && createdBySet.has("transactions")) {
		await prisma.$executeRaw`
			INSERT INTO transactions (id, user_id, organization_id, created_by_id, currency_code, quantity, principal_amount, fee_amount, exchange_rate, rate_source, rate_observed_at, plan_id, transacted_at, version, created_at, updated_at)
			SELECT id, usr_id, org_id, usr_id, 'USD', 1000.0000::decimal(20,4), 7200.0000::decimal(20,4), 0.0000::decimal(20,4), 7.2000000000::decimal(20,10), 'MANUAL', ts, plan_id, ts, 1, NOW(), NOW()
			FROM UNNEST(${txIds}::text[], ${txUserIds}::text[], ${txOrgIds}::text[], ${txPlanIds}::text[], ${txTimes}::timestamptz[])
				AS t(id, usr_id, org_id, plan_id, ts)
		`;
	} else if (createdBySet.has("transactions")) {
		await prisma.$executeRaw`
			INSERT INTO transactions (id, organization_id, created_by_id, currency_code, quantity, principal_amount, fee_amount, exchange_rate, rate_source, rate_observed_at, plan_id, transacted_at, version, created_at, updated_at)
			SELECT id, org_id, usr_id, 'USD', 1000.0000::decimal(20,4), 7200.0000::decimal(20,4), 0.0000::decimal(20,4), 7.2000000000::decimal(20,10), 'MANUAL', ts, plan_id, ts, 1, NOW(), NOW()
			FROM UNNEST(${txIds}::text[], ${txOrgIds}::text[], ${txUserIds}::text[], ${txPlanIds}::text[], ${txTimes}::timestamptz[])
				AS t(id, org_id, usr_id, plan_id, ts)
		`;
	} else {
		await prisma.$executeRaw`
			INSERT INTO transactions (id, organization_id, currency_code, quantity, principal_amount, fee_amount, exchange_rate, rate_source, rate_observed_at, plan_id, transacted_at, version, created_at, updated_at)
			SELECT id, org_id, 'USD', 1000.0000::decimal(20,4), 7200.0000::decimal(20,4), 0.0000::decimal(20,4), 7.2000000000::decimal(20,10), 'MANUAL', ts, plan_id, ts, 1, NOW(), NOW()
			FROM UNNEST(${txIds}::text[], ${txOrgIds}::text[], ${txPlanIds}::text[], ${txTimes}::timestamptz[])
				AS t(id, org_id, plan_id, ts)
		`;
	}

	// 8. cost_lots
	if (userIdSet.has("cost_lots")) {
		await prisma.$executeRaw`
			INSERT INTO cost_lots (id, user_id, organization_id, currency_code, source_type, source_id, quantity, remaining_qty, unit_cost, total_cost, acquired_at, created_at, updated_at)
			SELECT id, usr_id, org_id, 'USD', 'PURCHASE', src_id, 1000.0000::decimal(20,4), 900.0000::decimal(20,4), 7.2000000000::decimal(20,10), 7200.0000::decimal(20,4), ts, NOW(), NOW()
			FROM UNNEST(${lotIds}::text[], ${txUserIds}::text[], ${txOrgIds}::text[], ${txIds}::text[], ${txTimes}::timestamptz[])
				AS t(id, usr_id, org_id, src_id, ts)
		`;
	} else {
		await prisma.$executeRaw`
			INSERT INTO cost_lots (id, organization_id, currency_code, source_type, source_id, quantity, remaining_qty, unit_cost, total_cost, acquired_at, created_at, updated_at)
			SELECT id, org_id, 'USD', 'PURCHASE', src_id, 1000.0000::decimal(20,4), 900.0000::decimal(20,4), 7.2000000000::decimal(20,10), 7200.0000::decimal(20,4), ts, NOW(), NOW()
			FROM UNNEST(${lotIds}::text[], ${txOrgIds}::text[], ${txIds}::text[], ${txTimes}::timestamptz[])
				AS t(id, org_id, src_id, ts)
		`;
	}

	// 9. usage_records
	if (userIdSet.has("usage_records") && createdBySet.has("usage_records")) {
		await prisma.$executeRaw`
			INSERT INTO usage_records (id, user_id, organization_id, created_by_id, plan_id, currency_code, amount, used_at, version, created_at, updated_at)
			SELECT id, usr_id, org_id, usr_id, plan_id, 'USD', 100.0000::decimal(20,4), ts, 1, NOW(), NOW()
			FROM UNNEST(${usageIds}::text[], ${usageUserIds}::text[], ${usageOrgIds}::text[], ${usagePlanIds}::text[], ${usageTimes}::timestamptz[])
				AS t(id, usr_id, org_id, plan_id, ts)
		`;
	} else if (createdBySet.has("usage_records")) {
		await prisma.$executeRaw`
			INSERT INTO usage_records (id, organization_id, created_by_id, plan_id, currency_code, amount, used_at, version, created_at, updated_at)
			SELECT id, org_id, usr_id, plan_id, 'USD', 100.0000::decimal(20,4), ts, 1, NOW(), NOW()
			FROM UNNEST(${usageIds}::text[], ${usageOrgIds}::text[], ${usageUserIds}::text[], ${usagePlanIds}::text[], ${usageTimes}::timestamptz[])
				AS t(id, org_id, usr_id, plan_id, ts)
		`;
	} else {
		await prisma.$executeRaw`
			INSERT INTO usage_records (id, organization_id, plan_id, currency_code, amount, used_at, version, created_at, updated_at)
			SELECT id, org_id, plan_id, 'USD', 100.0000::decimal(20,4), ts, 1, NOW(), NOW()
			FROM UNNEST(${usageIds}::text[], ${usageOrgIds}::text[], ${usagePlanIds}::text[], ${usageTimes}::timestamptz[])
				AS t(id, org_id, plan_id, ts)
		`;
	}

	// 10. corrections
	if (userIdSet.has("corrections") && caps.hasCorrectionActorUserId) {
		await prisma.$executeRaw`
			INSERT INTO corrections (id, user_id, organization_id, actor_user_id, target_type, target_id, reason, before_snapshot, after_snapshot, status, created_at, updated_at)
			SELECT id, usr_id, org_id, usr_id, 'TRANSACTION', target_id, 'benchmark', '{}'::jsonb, '{}'::jsonb, 'APPLIED', NOW(), NOW()
			FROM UNNEST(${corrIds}::text[], ${corrUserIds}::text[], ${corrOrgIds}::text[], ${corrTargetIds}::text[])
				AS t(id, usr_id, org_id, target_id)
		`;
	} else if (caps.hasCorrectionActorUserId) {
		await prisma.$executeRaw`
			INSERT INTO corrections (id, organization_id, actor_user_id, target_type, target_id, reason, before_snapshot, after_snapshot, status, created_at, updated_at)
			SELECT id, org_id, usr_id, 'TRANSACTION', target_id, 'benchmark', '{}'::jsonb, '{}'::jsonb, 'APPLIED', NOW(), NOW()
			FROM UNNEST(${corrIds}::text[], ${corrOrgIds}::text[], ${corrUserIds}::text[], ${corrTargetIds}::text[])
				AS t(id, org_id, usr_id, target_id)
		`;
	} else {
		await prisma.$executeRaw`
			INSERT INTO corrections (id, organization_id, target_type, target_id, reason, before_snapshot, after_snapshot, status, created_at, updated_at)
			SELECT id, org_id, 'TRANSACTION', target_id, 'benchmark', '{}'::jsonb, '{}'::jsonb, 'APPLIED', NOW(), NOW()
			FROM UNNEST(${corrIds}::text[], ${corrOrgIds}::text[], ${corrTargetIds}::text[])
				AS t(id, org_id, target_id)
		`;
	}

	// 11. reminders
	if (userIdSet.has("reminders")) {
		await prisma.$executeRaw`
			INSERT INTO reminders (id, user_id, organization_id, type, plan_id, dedup_key, scheduled_for, created_at, updated_at)
			SELECT id, usr_id, org_id, 'PREP_DUE', plan_id, dedup_key, ts, NOW(), NOW()
			FROM UNNEST(${remIds}::text[], ${remUserIds}::text[], ${remOrgIds}::text[], ${remPlanIds}::text[], ${remDedupKeys}::text[], ${remTimes}::timestamptz[])
				AS t(id, usr_id, org_id, plan_id, dedup_key, ts)
		`;
	} else {
		await prisma.$executeRaw`
			INSERT INTO reminders (id, organization_id, type, plan_id, dedup_key, scheduled_for, created_at, updated_at)
			SELECT id, org_id, 'PREP_DUE', plan_id, dedup_key, ts, NOW(), NOW()
			FROM UNNEST(${remIds}::text[], ${remOrgIds}::text[], ${remPlanIds}::text[], ${remDedupKeys}::text[], ${remTimes}::timestamptz[])
				AS t(id, org_id, plan_id, dedup_key, ts)
		`;
	}

	// 12. audit_logs
	await prisma.$executeRaw`
		INSERT INTO audit_logs (id, organization_id, actor_user_id, actor_type, action, target_type, target_id, result, created_at)
		SELECT id, org_id, actor_id, 'USER', 'transaction.create', 'transaction', target_id, 'SUCCESS', ts
		FROM UNNEST(${auditIds}::text[], ${auditOrgIds}::text[], ${auditActorIds}::text[], ${auditTargetIds}::text[], ${auditTimes}::timestamptz[])
			AS t(id, org_id, actor_id, target_id, ts)
	`;

	// 刷新统计信息，确保优化器依据真实数据分布选择索引
	await prisma.$executeRawUnsafe(
		`ANALYZE memberships, accounts, plans, plan_allocations, transactions, cost_lots, usage_records, corrections, reminders, audit_logs`,
	);

	return {
		orgIds,
		userIdsByOrg: userIds,
		planIdsByOrg: planIds,
		txIdsByOrg: txIds,
		currencies,
		minWindowDate,
		counts: {
			users: userIds.length,
			organizations: orgIds.length,
			memberships: memIds.length,
			accounts: accIds.length,
			plans: planIds.length,
			plan_allocations: planAllocIds.length,
			transactions: txIds.length,
			cost_lots: lotIds.length,
			usage_records: usageIds.length,
			corrections: corrIds.length,
			reminders: remIds.length,
			audit_logs: auditIds.length,
		},
	};
}

async function cleanupSeededData(
	prisma: PrismaClient,
	runPrefix: string,
): Promise<void> {
	const escapedPrefix = runPrefix.replace(/[%_\\]/g, "\\$&");
	const prefixPattern = `${escapedPrefix}%`;
	const deleteOrder: readonly TrackedTable[] = [
		"audit_logs",
		"reminders",
		"corrections",
		"usage_records",
		"cost_lots",
		"transactions",
		"plan_allocations",
		"plans",
		"accounts",
		"memberships",
		"organizations",
		"users",
	];
	for (const table of deleteOrder) {
		await prisma.$executeRawUnsafe(
			`DELETE FROM "${table}" WHERE id LIKE $1 ESCAPE '\\'`,
			prefixPattern,
		);
	}
	await prisma.$executeRawUnsafe(
		`ANALYZE memberships, accounts, plans, plan_allocations, transactions, cost_lots, usage_records, corrections, reminders, audit_logs`,
	);
}

interface CoreQuerySpec {
	key: string;
	table: BenchmarkTable;
	description: string;
	expectedIndexPrefix: string;
	sql: string;
	buildParams: (iterIdx: number) => unknown[];
}

function buildCoreQueries(
	dataset: SeedDataset,
	rowsPerOrg: number,
): CoreQuerySpec[] {
	const orgCount = dataset.orgIds.length;
	return [
		{
			key: "memberships_auth",
			table: "memberships",
			description: "memberships (organization_id, user_id) 鉴权查询",
			expectedIndexPrefix: "memberships_organization_id_",
			sql: `SELECT id, role, status FROM memberships WHERE organization_id = $1 AND user_id = $2`,
			buildParams: (i) => {
				const o = i % orgCount;
				return [dataset.orgIds[o], dataset.userIdsByOrg[o]];
			},
		},
		{
			key: "accounts_by_currency",
			table: "accounts",
			description: "accounts (organization_id, currency_code) 查询",
			expectedIndexPrefix: "accounts_organization_id_",
			sql: `SELECT id, organization_id, currency_code, balance, updated_at FROM accounts WHERE organization_id = $1 AND currency_code = $2`,
			buildParams: (i) => {
				const o = i % orgCount;
				const c = dataset.currencies[i % dataset.currencies.length];
				return [dataset.orgIds[o], c];
			},
		},
		{
			key: "plans_list_by_status",
			table: "plans",
			description: "plans (organization_id, status) 列表查询",
			expectedIndexPrefix: "plans_organization_id_",
			sql: `SELECT id, organization_id, target_currency, target_amount, status, updated_at FROM plans WHERE organization_id = $1 AND status = $2 ORDER BY updated_at DESC LIMIT 50`,
			buildParams: (i) => {
				const o = i % orgCount;
				return [dataset.orgIds[o], i % 2 === 0 ? "ACTIVE" : "COMPLETED"];
			},
		},
		{
			key: "transactions_paginated",
			table: "transactions",
			description: "transactions (organization_id, transacted_at) 分页查询",
			expectedIndexPrefix: "transactions_organization_id_",
			sql: `SELECT id, organization_id, currency_code, quantity, principal_amount, transacted_at FROM transactions WHERE organization_id = $1 AND transacted_at >= $2 ORDER BY transacted_at DESC LIMIT 50`,
			buildParams: (i) => {
				const o = i % orgCount;
				return [dataset.orgIds[o], dataset.minWindowDate];
			},
		},
		{
			key: "usage_records_by_used_at",
			table: "usage_records",
			description: "usage_records (organization_id, used_at) 查询",
			expectedIndexPrefix: "usage_records_organization_id_",
			sql: `SELECT id, organization_id, plan_id, currency_code, amount, used_at FROM usage_records WHERE organization_id = $1 AND used_at >= $2 ORDER BY used_at DESC LIMIT 50`,
			buildParams: (i) => {
				const o = i % orgCount;
				return [dataset.orgIds[o], dataset.minWindowDate];
			},
		},
		{
			key: "corrections_by_target",
			table: "corrections",
			description: "corrections (organization_id, target_type, target_id) 查询",
			expectedIndexPrefix: "corrections_organization_id_",
			sql: `SELECT id, organization_id, target_type, target_id, status, created_at FROM corrections WHERE organization_id = $1 AND target_type = $2 AND target_id = $3 ORDER BY created_at DESC LIMIT 50`,
			buildParams: (i) => {
				const o = i % orgCount;
				const targetTxId = dataset.txIdsByOrg[o * rowsPerOrg];
				return [dataset.orgIds[o], "TRANSACTION", targetTxId];
			},
		},
		{
			key: "reminders_by_scheduled_for",
			table: "reminders",
			description: "reminders (organization_id, scheduled_for) 查询",
			expectedIndexPrefix: "reminders_organization_id_",
			sql: `SELECT id, organization_id, type, dedup_key, scheduled_for FROM reminders WHERE organization_id = $1 AND scheduled_for >= $2 ORDER BY scheduled_for DESC LIMIT 50`,
			buildParams: (i) => {
				const o = i % orgCount;
				return [dataset.orgIds[o], dataset.minWindowDate];
			},
		},
		{
			key: "audit_logs_paginated",
			table: "audit_logs",
			description: "audit_logs (organization_id, created_at DESC) 分页查询",
			expectedIndexPrefix: "audit_logs_organization_id_",
			sql: `SELECT id, organization_id, actor_user_id, actor_type, action, result, created_at FROM audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 50`,
			buildParams: (i) => {
				const o = i % orgCount;
				return [dataset.orgIds[o]];
			},
		},
	];
}

function collectPlanNodes(root: ExplainNode): ExplainNode[] {
	const nodes: ExplainNode[] = [root];
	if (Array.isArray(root.Plans)) {
		for (const child of root.Plans) {
			nodes.push(...collectPlanNodes(child));
		}
	}
	return nodes;
}

interface ExplainTopObject {
	Plan?: ExplainNode;
	"Planning Time"?: number;
	"Execution Time"?: number;
}

function parseExplainResult(rawRow: Record<string, unknown>): {
	planRoot: ExplainNode;
	planningTimeMs: number | null;
	executionTimeMs: number | null;
} {
	const rawPlan = rawRow["QUERY PLAN"];
	const parsedArray = (
		typeof rawPlan === "string" ? JSON.parse(rawPlan) : rawPlan
	) as ExplainTopObject[];
	const top = parsedArray[0];
	if (!top?.Plan) {
		throw new Error(`无法解析 EXPLAIN JSON 输出: ${JSON.stringify(rawRow)}`);
	}
	return {
		planRoot: top.Plan,
		planningTimeMs:
			typeof top["Planning Time"] === "number" ? top["Planning Time"] : null,
		executionTimeMs:
			typeof top["Execution Time"] === "number"
				? top["Execution Time"]
				: null,
	};
}

function percentile(sorted: readonly number[], p: number): number {
	const idx = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(p * sorted.length) - 1),
	);
	return Number(sorted[idx].toFixed(4));
}

function computeStats(
	samples: readonly number[],
	totalRowsReturned: number,
	warmup: number,
): LatencyStats {
	const sorted = [...samples].sort((a, b) => a - b);
	const sum = samples.reduce((acc, v) => acc + v, 0);
	return {
		iterations: samples.length,
		warmup,
		minMs: Number(sorted[0].toFixed(4)),
		meanMs: Number((sum / samples.length).toFixed(4)),
		p50Ms: percentile(sorted, 0.5),
		p95Ms: percentile(sorted, 0.95),
		p99Ms: percentile(sorted, 0.99),
		maxMs: Number(sorted[sorted.length - 1].toFixed(4)),
		avgRowsReturned: Number((totalRowsReturned / samples.length).toFixed(2)),
	};
}

async function runQueryBenchmark(
	prisma: PrismaClient,
	spec: CoreQuerySpec,
	caps: SchemaCapabilities,
	warmup: number,
	iterations: number,
): Promise<QueryBenchmarkResult> {
	const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${spec.sql}`;
	const explainParams = spec.buildParams(0);
	const explainRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
		explainSql,
		...explainParams,
	);
	const { planRoot, planningTimeMs, executionTimeMs } = parseExplainResult(
		explainRows[0],
	);
	const allNodes = collectPlanNodes(planRoot);
	const nodeTypes = allNodes.map((n) => n["Node Type"] ?? "Unknown");
	const seqScanCount = nodeTypes.filter((t) => t === "Seq Scan").length;

	const orgLeadingSet = new Set(caps.orgLeadingIndexesByTable[spec.table] ?? []);
	const indexScans: ExplainScanHit[] = allNodes
		.filter((n) =>
			["Index Scan", "Index Only Scan", "Bitmap Index Scan"].includes(
				n["Node Type"] ?? "",
			),
		)
		.map((n) => {
			const idxName = n["Index Name"] ?? null;
			return {
				nodeType: n["Node Type"] ?? "Unknown",
				relationName: n["Relation Name"] ?? null,
				indexName: idxName,
				isOrgLeadingIndex: idxName !== null && orgLeadingSet.has(idxName),
				actualTotalTimeMs:
					typeof n["Actual Total Time"] === "number"
						? n["Actual Total Time"]
						: null,
				actualRows:
					typeof n["Actual Rows"] === "number" ? n["Actual Rows"] : null,
			};
		});

	const orgLeadingIndexUsed = indexScans.some((hit) => hit.isOrgLeadingIndex);

	for (let w = 0; w < warmup; w += 1) {
		await prisma.$queryRawUnsafe<unknown[]>(spec.sql, ...spec.buildParams(w));
	}

	const samples: number[] = [];
	let totalRows = 0;
	for (let i = 0; i < iterations; i += 1) {
		const params = spec.buildParams(i);
		const start = performance.now();
		const rows = await prisma.$queryRawUnsafe<unknown[]>(spec.sql, ...params);
		const elapsed = performance.now() - start;
		samples.push(elapsed);
		totalRows += rows.length;
	}

	return {
		key: spec.key,
		table: spec.table,
		description: spec.description,
		expectedIndexPrefix: spec.expectedIndexPrefix,
		explain: {
			nodeTypes,
			seqScanCount,
			indexScans,
			orgLeadingIndexUsed,
			executionTimeMs,
			planningTimeMs,
			planRoot,
		},
		latency: computeStats(samples, totalRows, warmup),
	};
}

function buildComparison(
	comparePath: string,
	currentStage: string,
	currentQueries: readonly QueryBenchmarkResult[],
): BenchmarkReport["comparison"] {
	const raw = fs.readFileSync(path.resolve(comparePath), "utf8");
	const baseline = JSON.parse(raw) as Partial<BenchmarkReport>;
	const baselineByKey = new Map<string, QueryBenchmarkResult>();
	for (const q of baseline.queries ?? []) {
		baselineByKey.set(q.key, q);
	}
	const entries: BaselineComparisonEntry[] = [];
	for (const q of currentQueries) {
		const prev = baselineByKey.get(q.key);
		if (!prev) continue;
		entries.push({
			key: q.key,
			baselineP50Ms: prev.latency.p50Ms,
			currentP50Ms: q.latency.p50Ms,
			deltaP50Ms: Number((q.latency.p50Ms - prev.latency.p50Ms).toFixed(4)),
			baselineP95Ms: prev.latency.p95Ms,
			currentP95Ms: q.latency.p95Ms,
			deltaP95Ms: Number((q.latency.p95Ms - prev.latency.p95Ms).toFixed(4)),
		});
	}
	return {
		baselineFile: path.resolve(comparePath),
		baselineStage: baseline.schemaCapabilities?.stage ?? null,
		currentStage,
		entries,
	};
}

async function main(): Promise<number> {
	let opts: CliOptions;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}

	const repoRoot = getRepoRoot();
	let resolvedOutPath: string | null = null;
	if (opts.outPath !== null) {
		try {
			resolvedOutPath = assertSafeOutputPath(opts.outPath, repoRoot);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			return 1;
		}
	}

	let dbName: string;
	try {
		dbName = assertSafeLocalTestDatabase(
			process.env.DATABASE_URL,
			process.env.NODE_ENV,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}

	const runPrefix = `bench_p6_${Date.now()}_${randomBytes(3).toString("hex")}`;
	const prisma = new PrismaClient();

	let capabilities: SchemaCapabilities | null = null;
	let beforeCounts: Record<TrackedTable, number> | null = null;
	let afterCounts: Record<TrackedTable, number> | null = null;
	let seededCounts: Record<TrackedTable, number> | null = null;
	const queryResults: QueryBenchmarkResult[] = [];
	let runError: unknown = null;

	try {
		capabilities = await detectCapabilities(prisma);
		beforeCounts = await collectTableCounts(prisma);
		console.error(
			`[benchmark-p6] db=${dbName} stage=${capabilities.stage} prefix=${runPrefix} orgs=${opts.orgs} rowsPerOrg=${opts.rowsPerOrg}`,
		);

		const dataset = await seedIsolatedData(
			prisma,
			runPrefix,
			opts.orgs,
			opts.rowsPerOrg,
			capabilities,
		);
		seededCounts = dataset.counts;

		const specs = buildCoreQueries(dataset, opts.rowsPerOrg);
		for (const spec of specs) {
			const result = await runQueryBenchmark(
				prisma,
				spec,
				capabilities,
				opts.warmup,
				opts.iterations,
			);
			queryResults.push(result);
			console.error(
				`[benchmark-p6] ${result.key}: p50=${result.latency.p50Ms}ms p95=${result.latency.p95Ms}ms seqScan=${result.explain.seqScanCount} orgIdx=${result.explain.indexScans.map((s) => s.indexName).join(",")}`,
			);
		}
	} catch (error) {
		runError = error;
	} finally {
		try {
			await cleanupSeededData(prisma, runPrefix);
			afterCounts = await collectTableCounts(prisma);
		} catch (cleanupErr) {
			console.error(
				`[benchmark-p6] 清理失败: ${cleanupErr instanceof Error ? cleanupErr.stack : String(cleanupErr)}`,
			);
			if (!runError) runError = cleanupErr;
		}
		await prisma.$disconnect();
	}

	if (runError) {
		console.error(runError instanceof Error ? runError.stack : String(runError));
		return 1;
	}

	if (!capabilities || !beforeCounts || !afterCounts || !seededCounts) {
		console.error("[benchmark-p6] 内部状态缺失");
		return 1;
	}

	const zeroResidue = TRACKED_TABLES.every(
		(table) => beforeCounts?.[table] === afterCounts?.[table],
	);
	const allQueriesZeroSeqScan = queryResults.every(
		(q) => q.explain.seqScanCount === 0,
	);
	const allQueriesUsedOrgLeadingIndex = queryResults.every(
		(q) => q.explain.orgLeadingIndexUsed,
	);

	const report: BenchmarkReport = {
		generatedAt: new Date().toISOString(),
		database: dbName,
		runPrefix,
		config: {
			orgs: opts.orgs,
			rowsPerOrg: opts.rowsPerOrg,
			warmup: opts.warmup,
			iterations: opts.iterations,
		},
		schemaCapabilities: capabilities,
		seededCounts,
		beforeCounts,
		afterCounts,
		zeroResidueVerified: zeroResidue,
		queries: queryResults,
		assertions: {
			allQueriesZeroSeqScan,
			allQueriesUsedOrgLeadingIndex,
			zeroResidue,
		},
	};

	if (opts.comparePath) {
		report.comparison = buildComparison(
			opts.comparePath,
			capabilities.stage,
			queryResults,
		);
	}

	const serialized = JSON.stringify(report, null, 2);
	if (resolvedOutPath !== null) {
		fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
		fs.writeFileSync(resolvedOutPath, `${serialized}\n`, "utf8");
		console.error(`[benchmark-p6] 已写入结果文件: ${resolvedOutPath}`);
	} else {
		console.log(serialized);
	}

	if (!zeroResidue || !allQueriesZeroSeqScan || !allQueriesUsedOrgLeadingIndex) {
		console.error(
			`[benchmark-p6] 断言失败: zeroResidue=${zeroResidue}, allQueriesZeroSeqScan=${allQueriesZeroSeqScan}, allQueriesUsedOrgLeadingIndex=${allQueriesUsedOrgLeadingIndex}`,
		);
		return 1;
	}

	console.error(
		`[benchmark-p6] 全部通过：8 条核心查询均命中 organization_id 打头索引、0 Seq Scan、零数据残留`,
	);
	return 0;
}

void main().then((code) => {
	process.exitCode = code;
});
