/**
 * 旧缓存迁移清单与期望值推导（MVP-F0-1 B2·迁移演练，实施底稿 §3 唯一口径）。
 *
 * 候选分类、期望值派生、冻结校验与执行引擎由 CLI
 * （prisma/rate-cache-migration/migrate.ts）调用。执行模式由同事务内的数据库
 * 完成记录决定，写入和复跑均核对行归属与全冻结字段。
 *
 * 分类规则（底稿 §3.1/§3）：
 * - ErApi 候选：source=er-api 且 quote=TWD 且非恒等（底稿 §3.1 限定范围）；
 *   方向可证的前提 = 停写窗口内全库 er-api 行均为旧方向写入（人类停写后
 *   执行）+ 人工核对冻结 ID 白名单圈选（approvedCandidateIds）；
 * - Frankfurter 候选：source=frankfurter 且非恒等 → 同样原位转换；
 *   批序 ErApi 先行、Frankfurter 随后，全部候选在同一计划事务内执行；
 * - 排除：abc（百外币单位原生方向正确）、identity（恒等价 1）、未知来源；
 * - 冲突行单列不放行：sellRate 非空（仅 ABC 应有，非空即来源语义冲突）、
 *   rate ≤ 0 / 非法 / 舍入后为 0 / 超出 Decimal(20,10) 落库范围；
 * - 数值 = 1 的行：转换前后相同，仍按清单状态判定通过（更新条件原值匹配）。
 */
import { createHash } from "node:crypto";
import { invertQuoteRate } from "./rate-invert";

/** 迁移涉及的旧方向来源集合（转换候选；ABC/identity 方向本就正确，排除） */
export const LEGACY_DIRECTION_SOURCES = ["er-api", "frankfurter"] as const;

/** 冻结清单条目（inventory 冻结快照的最小字段，与底稿 §3.2 对齐；id 为数据库主键字符串） */
export interface InventoryRow {
	id: string;
	base: string;
	quote: string;
	source: string;
	/** 原值（十进制字符串，来自 Decimal(20,10) 列的 toString） */
	rate: string;
	sellRate: string | null;
	observedAt: string;
	createdAt: string;
}

/** 候选分类结论 */
export type InventoryRowVerdict =
	| {
			kind: "candidate";
			batch: "er-api" | "frankfurter";
			expectedRate: string;
	  }
	| { kind: "skip-noop"; batch: "er-api" | "frankfurter"; expectedRate: string }
	| {
			kind: "conflict";
			reason:
				| "sell-rate-non-null"
				| "invalid-rate"
				| "invert-rounds-to-zero"
				| "invert-out-of-range"
				| "erapi-quote-not-twd";
	  }
	| { kind: "excluded"; reason: "source-not-legacy" | "identity-pair" };

/** 冻结候选：整行快照随清单冻结（执行时全字段进条件更新，防部分漂移） */
export interface FrozenCandidate {
	row: InventoryRow;
	batch: "er-api" | "frankfurter";
	originalRate: string;
	expectedRate: string;
}

/** 冻结清单汇总（inventory/invert/rollback 三命令共用同一派生口径） */
export interface MigrationPlan {
	/** 全部冻结行（含排除/冲突，回滚与对账需要全量快照） */
	rows: InventoryRow[];
	candidates: FrozenCandidate[];
	conflicts: Array<{ id: string; reason: string }>;
	excludedCount: number;
	/** 候选行原值+期望值的校验和（SHA-256 hex；防漂移以 verifyFrozenPlan 全量比对为准） */
	checksum: string;
}

/**
 * 单行分类与期望新值派生：
 * - 候选行 expectedRate = invertQuoteRate(原值)（与 W2 新写入口径一致，HALF_UP 10 位）；
 * - 数值 1（恒等价）→ skip-noop（期望值 = 1，条件更新原值匹配后仍幂等）；
 * - 冲突行绝不给出期望值，绝不出现在转换 UPDATE 列表。
 */
export function classifyInventoryRow(
	row: InventoryRow,
): InventoryRowVerdict {
	const isIdentity = row.base === row.quote;
	const isLegacy =
		(LEGACY_DIRECTION_SOURCES as readonly string[]).includes(row.source);
	if (!isLegacy) {
		return { kind: "excluded", reason: "source-not-legacy" };
	}
	if (isIdentity) {
		return { kind: "excluded", reason: "identity-pair" };
	}
	const batch = row.source === "er-api" ? "er-api" : "frankfurter";
	// 底稿 §3.1：ErApi 候选限定「source=er-api 且 quote=TWD」的非恒等行；
	// 其他 ErApi 行（路由历史从未写入）属方向待核 → 冲突单列，不放行
	if (row.source === "er-api" && row.quote !== "TWD") {
		return { kind: "conflict", reason: "erapi-quote-not-twd" };
	}
	if (row.sellRate !== null && row.sellRate !== undefined) {
		return { kind: "conflict", reason: "sell-rate-non-null" };
	}
	// rate 列来自 Decimal(20,10)（恒非空）；防御性处理空串/非法为冲突行
	const rateText = typeof row.rate === "string" ? row.rate.trim() : "";
	if (!/^\d+(?:\.\d+)?$/.test(rateText)) {
		return { kind: "conflict", reason: "invalid-rate" };
	}
	let expectedRate: string;
	try {
		expectedRate = invertQuoteRate(rateText, row.base, row.quote);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("舍入为 0")) {
			return { kind: "conflict", reason: "invert-rounds-to-zero" };
		}
		if (message.includes("超出落库范围")) {
			return { kind: "conflict", reason: "invert-out-of-range" };
		}
		return { kind: "conflict", reason: "invalid-rate" };
	}
	if (expectedRate === "1.0000000000") {
		// 1/rate == 1 ⟺ rate == 1：转换前后相同 → no-op（仍进清单，状态判定通过）
		return { kind: "skip-noop", batch, expectedRate };
	}
	return { kind: "candidate", batch, expectedRate };
}

/** 由冻结行集派生迁移计划（同输入恒同输出；候选整行快照随清单冻结）。
 * 重复主键（同一 id 出现两次，可构造「原值+目标值」双重转换）→ 直接拒绝 */
export function deriveMigrationPlan(rows: InventoryRow[]): MigrationPlan {
	const seenIds = new Set<string>();
	for (const row of rows) {
		if (seenIds.has(row.id)) {
			throw new Error(
				`冻结清单存在重复主键 id=${row.id}：同一行不可出现两次` +
					"（防「原值+目标值」双重转换），请重新盘点冻结",
			);
		}
		seenIds.add(row.id);
	}
	const candidates: FrozenCandidate[] = [];
	const conflicts: Array<{ id: string; reason: string }> = [];
	let excludedCount = 0;
	for (const row of rows) {
		const verdict = classifyInventoryRow(row);
		if (verdict.kind === "candidate") {
			candidates.push({
				row,
				batch: verdict.batch,
				originalRate: row.rate,
				expectedRate: verdict.expectedRate,
			});
		} else if (verdict.kind === "skip-noop") {
			candidates.push({
				row,
				batch: verdict.batch,
				originalRate: row.rate,
				expectedRate: verdict.expectedRate,
			});
		} else if (verdict.kind === "conflict") {
			conflicts.push({ id: row.id, reason: verdict.reason });
		} else {
			excludedCount += 1;
		}
	}
	const candidatesSorted = [...candidates].sort((left, right) =>
		left.row.id < right.row.id ? -1 : left.row.id > right.row.id ? 1 : 0,
	);
	return {
		rows,
		candidates: candidatesSorted,
		conflicts,
		excludedCount,
		checksum: checksumOfPlan(
			candidatesSorted.map((candidate) => ({
				id: candidate.row.id,
				originalRate: candidate.originalRate,
				expectedRate: candidate.expectedRate,
			})),
		),
	};
}

/**
 * 计划校验和：id/originalRate/expectedRate 按 id 排序后序列化 → SHA-256（hex）。
 * 防漂移以 verifyFrozenPlan 的全量比对为准（校验和单独不足以防 candidates 篡改）。
 */
export function checksumOfPlan(
	candidates: Array<{
		id: string;
		originalRate: string;
		expectedRate: string;
	}>,
): string {
	const payload = [...candidates]
		.sort((left, right) =>
			left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
		)
		.map(
			(candidate) =>
				`${candidate.id}:${candidate.originalRate}:${candidate.expectedRate}`,
		)
		.join("|");
	return createHash("sha256").update(payload).digest("hex");
}

/**
 * 冻结清单校验（底稿 §3.1「排除已正确写入行」的人工圈选机制）：
 *
 * 1. 重算计划与冻结快照【全量】比对（candidates/conflicts/excludedCount/
 *    checksum 四者逐一相等）——rows 侧任何篡改都会被拒绝；
 * 2. approvedCandidateIds（人工方向证据圈选）必须是重算候选 id 的子集——
 *    自动分类只能给出「可疑候选」，是否确为旧方向由人工核对圈选；
 * 3. 通过后返回【重算计划】，其 candidates 已过滤为仅含 approved 圈选行
 *    （执行侧永不使用 stdin 的 candidates，且未圈选行不转换）。
 */
/** 冻结行运行时结构校验（stdin JSON 不可信：任一必填字段缺失/类型错误即拒绝——
 * 尤其 sellRate 键被删除（undefined）会绕过该字段的漂移防线，必须在此拦截） */
export function assertFrozenRowsShape(rows: unknown): asserts rows is InventoryRow[] {
	if (!Array.isArray(rows)) {
		throw new Error("冻结清单 plan.rows 必须为数组");
	}
	const isString = (value: unknown): value is string =>
		typeof value === "string";
	for (const row of rows) {
		if (row === null || typeof row !== "object") {
			throw new Error("冻结清单 plan.rows 条目必须为对象");
		}
		const record = row as Record<string, unknown>;
		const idText = isString(record.id) ? record.id : "<非字符串>";
		const missing = ["id", "base", "quote", "source", "rate", "observedAt", "createdAt"].filter(
			(key) => !isString(record[key]),
		);
		if (missing.length > 0) {
			throw new Error(
				`冻结行 id=${idText} 缺失或类型错误的必填字段：${missing.join("、")}（undefined 不可作为字段值）`,
			);
		}
		if (record.sellRate !== null && !isString(record.sellRate)) {
			throw new Error(
				`冻结行 id=${idText} 的 sellRate 必须为 null 或字符串（缺失/undefined 一律拒绝）`,
			);
		}
	}
}

export function verifyFrozenPlan(
	frozen: {
		rows: InventoryRow[];
		candidates: FrozenCandidate[];
		conflicts: Array<{ id: string; reason: string }>;
		excludedCount: number;
		checksum: string;
		approvedCandidateIds?: string[];
	},
): MigrationPlan {
	assertFrozenRowsShape(frozen.rows);
	const recomputed = deriveMigrationPlan(frozen.rows);
	const candidatesMatch =
		JSON.stringify(recomputed.candidates) ===
		JSON.stringify(frozen.candidates);
	const conflictsMatch =
		JSON.stringify(recomputed.conflicts) ===
		JSON.stringify(frozen.conflicts);
	if (
		!candidatesMatch ||
		!conflictsMatch ||
		recomputed.excludedCount !== frozen.excludedCount ||
		recomputed.checksum !== frozen.checksum
	) {
		throw new Error(
			"冻结清单与重算计划不一致（candidates/conflicts/excludedCount/checksum " +
				"任一不匹配）：冻结后数据可能已被改动，禁止执行" +
				"（§3.1 原值仍可判定时才放行）",
		);
	}
	const approved = new Set(frozen.approvedCandidateIds ?? []);
	const candidateIds = new Set(
		recomputed.candidates.map((candidate) => candidate.row.id),
	);
	for (const id of approved) {
		if (!candidateIds.has(id)) {
			throw new Error(
				`人工圈选的 approvedCandidateIds 含非候选 id（${id}）：` +
					"圈选集必须 ⊆ 重算候选集（防绕过分类规则）",
			);
		}
	}
	return {
		...recomputed,
		candidates: recomputed.candidates.filter((candidate) =>
			approved.has(candidate.row.id),
		),
	};
}

/** 迁移事务的最小接口（Prisma 事务客户端的结构子集，测试用内存假件实现；
 * rate/sellRate 以 { toString } 结构兼容 Prisma Decimal） */
export interface MigrationTx {
	updateMany(args: {
		where: {
			id: string;
			rate: string;
			base: string;
			quote: string;
			source: string;
			sellRate: string | null;
			observedAt: Date;
			createdAt: Date;
			migrationOwnerId: string | null;
		};
		data: { rate: string; migrationOwnerId: string | null };
	}): Promise<{ count: number }>;
	findUnique(args: {
		where: { id: string };
	}): Promise<{
		rate: { toString(): string };
		base: string;
		quote: string;
		source: string;
		sellRate: { toString(): string } | null;
		observedAt: Date;
		createdAt: Date;
		migrationOwnerId: string | null;
	} | null>;
}

/** Decimal 字符串数值归一（去尾零；"5.0000000000" → "5"、"0.500" → "0.5"）：
 * Prisma Decimal.toString() 会去尾零，幂等比对必须在归一化域进行 */
export function normalizeDecimalText(text: string): string {
	const trimmed = text.trim();
	const dotIndex = trimmed.indexOf(".");
	if (dotIndex === -1) return trimmed;
	const intPart = trimmed.slice(0, dotIndex);
	const fracPart = trimmed.slice(dotIndex + 1).replace(/0+$/, "");
	return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

export interface MigrationBatchSummary {
	converted: number;
	alreadyDone: number;
}

export interface MigrationExecution {
	inventoryId: string;
	mode: "invert" | "verify-inverted" | "rollback" | "verify-rolled-back";
}

/** 首次执行要求全字段和行归属均命中。复跑与数值不变的行只读核对。 */
export async function executeMigrationBatches(
	tx: MigrationTx,
	candidates: FrozenCandidate[],
	{ inventoryId, mode }: MigrationExecution,
): Promise<MigrationBatchSummary> {
	const summary: MigrationBatchSummary = { converted: 0, alreadyDone: 0 };
	const reverse = mode === "rollback" || mode === "verify-rolled-back";
	const verifyOnly = mode === "verify-inverted" || mode === "verify-rolled-back";
	const expectOwned = mode === "rollback" || mode === "verify-inverted";

	for (const candidate of candidates) {
		const { row } = candidate;
		const fromRate = reverse ? candidate.expectedRate : candidate.originalRate;
		const toRate = reverse ? candidate.originalRate : candidate.expectedRate;
		const noChange = normalizeDecimalText(fromRate) === normalizeDecimalText(toRate);
		const migrationOwnerId = expectOwned && !noChange ? inventoryId : null;

		if (verifyOnly || noChange) {
			const existing = await tx.findUnique({ where: { id: row.id } });
			if (
				existing === null ||
				existing.migrationOwnerId !== migrationOwnerId ||
				normalizeDecimalText(existing.rate.toString()) !== normalizeDecimalText(toRate) ||
				!frozenRowMatchesExceptRate(existing, row)
			) {
				throw new Error(`候选 id=${row.id} 行缺失、冻结字段漂移或迁移归属不匹配`);
			}
			summary.alreadyDone += 1;
			continue;
		}

		const result = await tx.updateMany({
			where: {
				id: row.id,
				rate: fromRate,
				base: row.base,
				quote: row.quote,
				source: row.source,
				sellRate: row.sellRate,
				observedAt: new Date(row.observedAt),
				createdAt: new Date(row.createdAt),
				migrationOwnerId,
			},
			data: { rate: toRate, migrationOwnerId: reverse ? null : inventoryId },
		});
		if (result.count !== 1) {
			throw new Error(`候选 id=${row.id} 条件未命中（行缺失、冻结字段漂移或迁移归属不匹配）`);
		}
		summary.converted += 1;
	}
	return summary;
}

/** 全计划批序执行（底稿 §3.3/§3.4）：er-api 批先行、frankfurter 批随后，
 * 同一事务内顺序执行 executeMigrationBatches；任一批抛错即向上传播
 * （调用方的 $transaction 回滚整个计划——含已执行的前批，无任何半写）。
 * CLI 的 $transaction 包装不覆盖本组合逻辑，故抽出以便差分测试：
 * 「前批成功、后批漂移」必须由调用方事务回滚前批（见 spec 组合用例）。 */
export async function executePlanBatches(
	tx: MigrationTx,
	plan: MigrationPlan,
	execution: MigrationExecution,
): Promise<{
	converted: number;
	alreadyDone: number;
	batches: Record<
		"er-api" | "frankfurter",
		{ converted: number; alreadyDone: number }
	>;
}> {
	const summary = {
		converted: 0,
		alreadyDone: 0,
		batches: {
			"er-api": { converted: 0, alreadyDone: 0 },
			frankfurter: { converted: 0, alreadyDone: 0 },
		} as Record<
			"er-api" | "frankfurter",
			{ converted: number; alreadyDone: number }
		>,
	};
	for (const batch of ["er-api", "frankfurter"] as const) {
		const batchCandidates = plan.candidates.filter(
			(candidate) => candidate.batch === batch,
		);
		if (batchCandidates.length === 0) continue;
		const batchSummary = await executeMigrationBatches(tx, batchCandidates, execution);
		summary.batches[batch] = batchSummary;
		summary.converted += batchSummary.converted;
		summary.alreadyDone += batchSummary.alreadyDone;
	}
	return summary;
}

/** 除 rate（数值归一化域由调用方判定）外的全字段精确比对
 *（sellRate 经 toString 归一——Prisma Decimal | null） */
function frozenRowMatchesExceptRate(
	existing: {
		base: string;
		quote: string;
		source: string;
		sellRate: { toString(): string } | null;
		observedAt: Date;
		createdAt: Date;
	},
	row: InventoryRow,
): boolean {
	const existingSellRate =
		existing.sellRate === null ? null : existing.sellRate.toString();
	return (
		existing.base === row.base &&
		existing.quote === row.quote &&
		existing.source === row.source &&
		existingSellRate === row.sellRate &&
		existing.observedAt.toISOString() === row.observedAt &&
		existing.createdAt.toISOString() === row.createdAt
	);
}
