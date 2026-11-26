/**
 * 旧缓存迁移计划属性与分类测试（MVP-F0-1 B2，实施底稿 §3 / FX-06）。
 *
 * 覆盖：候选分类规则、期望值派生（与 W2 取倒数口径一致）、幂等性构造
 * （同一冻结清单二次派生恒同）、verifyFrozenPlan 全量防篡改（候选/冲突/
 * 排除/校验和四侧比对）、executeMigrationBatches 可执行差分（首次转换、
 * 二次 0 更新、冻结字段漂移中止、逐字段零差异条件、回滚方向）。
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
	checksumOfPlan,
	classifyInventoryRow,
	deriveMigrationPlan,
	executeMigrationBatches,
	executePlanBatches,
	verifyFrozenPlan,
	type FrozenCandidate,
	type InventoryRow,
	type MigrationTx,
} from "./rate-migration-plan";

const rowOf = (overrides: Partial<InventoryRow> = {}): InventoryRow => ({
	id: "row-1",
	base: "CNY",
	quote: "TWD",
	source: "er-api",
	rate: "4.7567000000",
	sellRate: null,
	observedAt: "2026-09-15T00:00:00.000Z",
	createdAt: "2026-09-15T00:02:00.000Z",
	...overrides,
});

describe("classifyInventoryRow 分类规则", () => {
	it("ErApi TWD 旧行 → er-api 批候选，期望值与 W2 口径一致（4.7567 → 0.2102297812）", () => {
		const verdict = classifyInventoryRow(rowOf());
		expect(verdict).toEqual({
			kind: "candidate",
			batch: "er-api",
			expectedRate: "0.2102297812",
		});
	});

	it("Frankfurter 旧行 → frankfurter 批候选（MYR 对；0.2 → 5.0000000000，与 FX-01 夹具同口径）", () => {
		const verdict = classifyInventoryRow(
			rowOf({
				source: "frankfurter",
				base: "USD",
				quote: "MYR",
				rate: "0.2000000000",
			}),
		);
		expect(verdict).toEqual({
			kind: "candidate",
			batch: "frankfurter",
			expectedRate: "5.0000000000",
		});
	});

	it("abc / identity 来源 → 排除；恒等币对（base = quote）→ 排除", () => {
		expect(classifyInventoryRow(rowOf({ source: "abc" }))).toEqual({
			kind: "excluded",
			reason: "source-not-legacy",
		});
		expect(classifyInventoryRow(rowOf({ source: "identity" }))).toEqual({
			kind: "excluded",
			reason: "source-not-legacy",
		});
		expect(
			classifyInventoryRow(rowOf({ source: "er-api", base: "TWD", quote: "TWD" })),
		).toEqual({ kind: "excluded", reason: "identity-pair" });
	});

	it("冲突行单列不放行：sellRate 非空 / 非法 rate / 取倒数归零 / 超出落库范围 / ErApi 非 TWD", () => {
		expect(classifyInventoryRow(rowOf({ sellRate: "32.50000000" }))).toEqual({
			kind: "conflict",
			reason: "sell-rate-non-null",
		});
		expect(classifyInventoryRow(rowOf({ rate: "abc" }))).toEqual({
			kind: "conflict",
			reason: "invalid-rate",
		});
		expect(classifyInventoryRow(rowOf({ rate: "20000000001" }))).toEqual({
			kind: "conflict",
			reason: "invert-rounds-to-zero",
		});
		expect(classifyInventoryRow(rowOf({ rate: "0.0000000001" }))).toEqual({
			kind: "conflict",
			reason: "invert-out-of-range",
		});
		// 底稿 §3.1：ErApi 候选限定 quote=TWD；其他 ErApi 行方向待核 → 冲突
		expect(
			classifyInventoryRow(rowOf({ base: "CNY", quote: "HKD" })),
		).toEqual({ kind: "conflict", reason: "erapi-quote-not-twd" });
	});

	it("数值 1 的行 → skip-noop（转换前后相同，仍进清单状态判定）", () => {
		const verdict = classifyInventoryRow(rowOf({ rate: "1.0000000000" }));
		expect(verdict).toEqual({
			kind: "skip-noop",
			batch: "er-api",
			expectedRate: "1.0000000000",
		});
	});

	it("冻结清单中的科学计数法仍判为非法汇率", () => {
		expect(classifyInventoryRow(rowOf({ rate: "1e-8" }))).toEqual({
			kind: "conflict",
			reason: "invalid-rate",
		});
	});
});

describe("deriveMigrationPlan 属性", () => {
	it("幂等性构造：同一冻结清单二次派生恒同（同输入恒同输出）；候选按 id 字典序排列", () => {
		const rows = [
			rowOf({ id: "row-3", rate: "4.7567000000" }),
			rowOf({ id: "row-1", source: "frankfurter", quote: "MYR", rate: "0.6102000000" }),
			rowOf({ id: "row-2", source: "abc" }),
			rowOf({ id: "row-4", sellRate: "1.00000000" }),
		];
		const first = deriveMigrationPlan(rows);
		const second = deriveMigrationPlan(rows);
		expect(second.checksum).toBe(first.checksum);
		expect(second.candidates).toEqual(first.candidates);
		// 候选携带整行快照（执行时全字段进条件），排序按 id 字典序
		expect(first.candidates.map((candidate) => candidate.row.id)).toEqual([
			"row-1",
			"row-3",
		]);
		expect(first.candidates[0]?.row).toEqual(rows[1]);
	});

	it("期望值二次取倒数往返：invert(expected) ≈ original（双程量化界 x²·5e-10 量级；生成域 ≤ 1000）", () => {
		const property = fc
			.record({
				id: fc
					.stringMatching(/^[A-Za-z0-9]{8,12}$/)
					.filter((id) => id.length > 0),
				intPart: fc.integer({ min: 0, max: 999 }),
				frac: fc.integer({ min: 1, max: 99_999_999 }),
			})
			.map(({ id, intPart, frac }) =>
				rowOf({
					id,
					rate: `${intPart}.${String(frac).padStart(8, "0")}`,
				}),
			);
		fc.assert(
			fc.property(property, (row) => {
				const verdict = classifyInventoryRow(row);
				if (verdict.kind !== "candidate") return;
				const roundTrip = classifyInventoryRow(
					rowOf({ ...row, rate: verdict.expectedRate }),
				);
				if (roundTrip.kind !== "candidate") return;
				// expected = 1/x ± 5e-10 → 1/expected − x 的双程界：
				// x²·5e-10/(1 − x·5e-10) + 5e-10（x ≤ 1000，分母恒正）
				const original = Number(row.rate);
				const back = Number(roundTrip.expectedRate);
				const bound =
					(original * original * 5e-10) / (1 - original * 5e-10) + 5e-10;
				expect(Math.abs(back - original)).toBeLessThanOrEqual(bound);
			}),
			{ numRuns: 200 },
		);
	});

	it("重复主键拒绝：同一 id 两条候选（原值+目标值双重转换构造）→ 派生即拒绝", () => {
		const duplicated = [
			rowOf({ id: "dup-1", rate: "4.7567000000" }),
			rowOf({ id: "dup-1", rate: "0.2102297812" }),
		];
		expect(() => deriveMigrationPlan(duplicated)).toThrow(/重复主键/);
	});

	it("校验和敏感性：候选集合任一行变化 → 校验和变化（防漂移以 verifyFrozenPlan 全量比对为准）", () => {
		const base = deriveMigrationPlan([
			rowOf({ id: "row-7", rate: "4.7567000000" }),
		]);
		const altered = deriveMigrationPlan([
			rowOf({ id: "row-7", rate: "4.7568000000" }),
		]);
		expect(base.checksum).not.toBe(altered.checksum);
	});
});

describe("checksumOfPlan", () => {
	it("空候选 → 空输入 SHA-256；顺序无关（内部按 id 排序，直接调用亦稳定）", () => {
		const empty = checksumOfPlan([]);
		expect(empty).toHaveLength(64);
		const forward = checksumOfPlan([
			{ id: "row-2", originalRate: "1.0000000000", expectedRate: "1.0000000000" },
			{ id: "row-1", originalRate: "4.7567000000", expectedRate: "0.2102297812" },
		]);
		const backward = checksumOfPlan([
			{ id: "row-1", originalRate: "4.7567000000", expectedRate: "0.2102297812" },
			{ id: "row-2", originalRate: "1.0000000000", expectedRate: "1.0000000000" },
		]);
		expect(forward).toBe(backward);
	});
});

describe("verifyFrozenPlan 全量防篡改与人工圈选", () => {
	const plan = deriveMigrationPlan([
		rowOf({ id: "cand-1", rate: "4.7567000000" }),
		rowOf({ id: "cand-2", source: "abc" }),
		rowOf({ id: "cand-3", sellRate: "1.00000000" }),
	]);

	it("一致冻结清单通过：approved 圈选为空 → 候选集为空（未圈选不转换）", () => {
		const verified = verifyFrozenPlan({
			rows: plan.rows,
			candidates: plan.candidates,
			conflicts: plan.conflicts,
			excludedCount: plan.excludedCount,
			checksum: plan.checksum,
			approvedCandidateIds: [],
		});
		expect(verified.candidates).toEqual([]);
	});

	it("冻结行结构校验：sellRate 键被删除（undefined）→ 拒绝（防绕过该字段漂移防线）", () => {
		const rowsWithoutSellRate = plan.rows.map((row) => {
			const clone: Record<string, unknown> = { ...row };
			delete clone.sellRate;
			return clone as unknown as InventoryRow;
		});
		expect(() =>
			verifyFrozenPlan({
				rows: rowsWithoutSellRate,
				candidates: plan.candidates,
				conflicts: plan.conflicts,
				excludedCount: plan.excludedCount,
				checksum: plan.checksum,
				approvedCandidateIds: [],
			}),
		).toThrow(/sellRate 必须为 null 或字符串/);
	});

	it("冻结行结构校验：必填字段缺失/类型错误 → 拒绝", () => {
		const missingRate = plan.rows.map((row) => {
			const clone: Record<string, unknown> = { ...row };
			delete clone.rate;
			return clone as unknown as InventoryRow;
		});
		expect(() =>
			verifyFrozenPlan({
				rows: missingRate,
				candidates: plan.candidates,
				conflicts: plan.conflicts,
				excludedCount: plan.excludedCount,
				checksum: plan.checksum,
				approvedCandidateIds: [],
			}),
		).toThrow(/缺失或类型错误的必填字段/);
	});

	it("approvedCandidateIds ⊆ 重算候选：过滤后仅含圈选行", () => {
		const verified = verifyFrozenPlan({
			rows: plan.rows,
			candidates: plan.candidates,
			conflicts: plan.conflicts,
			excludedCount: plan.excludedCount,
			checksum: plan.checksum,
			approvedCandidateIds: ["cand-1"],
		});
		expect(verified.candidates).toEqual([
			plan.candidates.find((candidate) => candidate.row.id === "cand-1"),
		]);
	});

	it("圈选非候选 id / 篡改候选 / 篡改冲突·排除·校验和 → 拒绝执行", () => {
		const base = {
			rows: plan.rows,
			candidates: plan.candidates,
			conflicts: plan.conflicts,
			excludedCount: plan.excludedCount,
			checksum: plan.checksum,
		};
		expect(() =>
			verifyFrozenPlan({
				...base,
				approvedCandidateIds: ["not-a-candidate"],
			}),
		).toThrow(/圈选集必须 ⊆ 重算候选集/);
		const tampered: FrozenCandidate[] = plan.candidates.map((candidate) =>
			candidate.row.id === "cand-1"
				? { ...candidate, expectedRate: "9.9999999999" }
				: candidate,
		);
		expect(() =>
			verifyFrozenPlan({
				...base,
				candidates: tampered,
				approvedCandidateIds: ["cand-1"],
			}),
		).toThrow(/冻结清单与重算计划不一致/);
		expect(() =>
			verifyFrozenPlan({
				...base,
				conflicts: [{ id: "ghost", reason: "invalid-rate" }],
				approvedCandidateIds: [],
			}),
		).toThrow(/冻结清单与重算计划不一致/);
		expect(() =>
			verifyFrozenPlan({
				...base,
				excludedCount: plan.excludedCount + 1,
				approvedCandidateIds: [],
			}),
		).toThrow(/冻结清单与重算计划不一致/);
		expect(() =>
			verifyFrozenPlan({ ...base, checksum: "0".repeat(64), approvedCandidateIds: [] }),
		).toThrow(/冻结清单与重算计划不一致/);
	});
});

const inventoryId = "fce2fa96-a93e-4de9-a821-83df7ab83829";
type TestRow = InventoryRow & {
	migrationOwnerId?: string | null;
	canonicalWriteId?: string | null;
};

/** 内存假事务：记录全部条件（逐字段零差异断言用）；updateMany 按【全字段】匹配评估；
 * findUnique 返回全冻结字段（无指数十进制文本和 Date 对象） */
function makeFakeTx(rows: Map<string, TestRow>): MigrationTx & {
	conditions: Array<Record<string, unknown>>;
} {
	const conditions: Array<Record<string, unknown>> = [];
	return {
		conditions,
		async updateMany(args) {
			conditions.push(args.where);
			const row = rows.get(args.where.id);
			if (!row) return { count: 0 };
			const observedAtIso = args.where.observedAt.toISOString();
			const createdAtIso = args.where.createdAt.toISOString();
			const match =
				row.rate === args.where.rate &&
				row.base === args.where.base &&
				row.quote === args.where.quote &&
				row.source === args.where.source &&
				row.sellRate === args.where.sellRate &&
				row.observedAt === observedAtIso &&
				row.createdAt === createdAtIso &&
				(row.migrationOwnerId ?? null) === args.where.migrationOwnerId &&
				(row.canonicalWriteId ?? null) === args.where.canonicalWriteId;
			if (!match) return { count: 0 };
			rows.set(row.id, { ...row, ...args.data });
			return { count: 1 };
		},
		async findUnique(args) {
			const row = rows.get(args.where.id);
			if (!row) return null;
			return {
				rate: row.rate,
				base: row.base,
				quote: row.quote,
				source: row.source,
				sellRate: row.sellRate,
				observedAt: new Date(row.observedAt),
				createdAt: new Date(row.createdAt),
				migrationOwnerId: row.migrationOwnerId ?? null,
				canonicalWriteId: row.canonicalWriteId ?? null,
			};
		},
	};
}

describe("executeMigrationBatches 可执行差分（FX-06 可执行化）", () => {
	it("首次转换：全部条件命中 converted；逐字段条件零差异（rate 之外冻结字段全进 where；CUID 字符串 id）", async () => {
		const plan = deriveMigrationPlan([
			rowOf({ id: "cmwx1", rate: "4.7567000000" }),
		]);
		const rows = new Map([
			["cmwx1", rowOf({ id: "cmwx1", rate: "4.7567000000" })],
		]);
		const tx = makeFakeTx(rows);

		const summary = await executeMigrationBatches(tx, plan.candidates, {
			inventoryId,
			mode: "invert",
		});

		expect(summary).toEqual({ converted: 1, alreadyDone: 0 });
		expect(rows.get("cmwx1")).toMatchObject({
			rate: "0.2102297812",
			migrationOwnerId: inventoryId,
		});
		// 逐字段零差异：where 携带冻结整行（base/quote/source/sellRate/observedAt/createdAt）
		expect(tx.conditions[0]).toEqual({
			id: "cmwx1",
			rate: "4.7567000000",
			base: "CNY",
			quote: "TWD",
			source: "er-api",
			sellRate: null,
			observedAt: new Date("2026-09-15T00:00:00.000Z"),
			createdAt: new Date("2026-09-15T00:02:00.000Z"),
			migrationOwnerId: null,
			canonicalWriteId: null,
		});
	});

	it("二次执行（幂等复跑）：行已为目标值 → 更新数 0、alreadyDone 计数", async () => {
		const plan = deriveMigrationPlan([
			rowOf({ id: "cmwx1", rate: "4.7567000000" }),
		]);
		const rows = new Map([
			["cmwx1", {
				...rowOf({ id: "cmwx1", rate: "0.2102297812" }),
				migrationOwnerId: inventoryId,
			}],
		]);
		const tx = makeFakeTx(rows);

		const summary = await executeMigrationBatches(tx, plan.candidates, {
			inventoryId,
			mode: "verify-inverted",
		});

		expect(summary).toEqual({ converted: 0, alreadyDone: 1 });
		expect(tx.conditions).toHaveLength(0);
	});

	it("尾零目标值（0.2 → 5.0000000000，落库读回 \"5\"）→ 幂等复跑在数值归一化域判定 alreadyDone", async () => {
		const plan = deriveMigrationPlan([
			rowOf({ id: "cmwx2", rate: "0.2000000000" }),
		]);
		// Prisma Decimal.toFixed() 无参数时去尾零：5.0000000000 落库读回 "5"
		const rows = new Map([
			["cmwx2", {
				...rowOf({ id: "cmwx2", rate: "5" }),
				migrationOwnerId: inventoryId,
			}],
		]);
		const tx = makeFakeTx(rows);

		const summary = await executeMigrationBatches(tx, plan.candidates, {
			inventoryId,
			mode: "verify-inverted",
		});

		expect(summary).toEqual({ converted: 0, alreadyDone: 1 });
		expect(tx.conditions).toHaveLength(0);
	});

	it("冻结字段漂移（observedAt 被并发改写）→ 全字段条件 0 命中 → 抛错中止该批", async () => {
		const plan = deriveMigrationPlan([
			rowOf({ id: "cmwx1", rate: "4.7567000000" }),
		]);
		// rate 与冻结值一致，但 observedAt 已漂移 → 全字段条件不命中
		const rows = new Map([
			[
				"cmwx1",
				rowOf({
					id: "cmwx1",
					rate: "4.7567000000",
					observedAt: "2026-09-15T00:03:00.000Z",
				}),
			],
		]);
		const tx = makeFakeTx(rows);

		await expect(
			executeMigrationBatches(tx, plan.candidates, { inventoryId, mode: "invert" }),
		).rejects.toThrow(/条件未命中/);
	});

	it("回滚方向：fromRate/expectedRate 互换，恢复原值", async () => {
		const plan = deriveMigrationPlan([
			rowOf({ id: "cmwx1", rate: "4.7567000000" }),
		]);
		const rows = new Map([
			["cmwx1", {
				...rowOf({ id: "cmwx1", rate: "0.2102297812" }),
				migrationOwnerId: inventoryId,
			}],
		]);
		const tx = makeFakeTx(rows);

		const summary = await executeMigrationBatches(tx, plan.candidates, {
			inventoryId,
			mode: "rollback",
		});

		expect(summary).toEqual({ converted: 1, alreadyDone: 0 });
		expect(rows.get("cmwx1")).toMatchObject({
			rate: "4.7567000000",
			migrationOwnerId: null,
		});
	});

it("数值不变的行也取得方向证据，复跑仍为零写入", async () => {
		const plan = deriveMigrationPlan([rowOf({ id: "cmwnoop", rate: "1.0000000000" })]);
		const rows = new Map([
			["cmwnoop", rowOf({ id: "cmwnoop", rate: "1.0000000000" })],
		]);
		const tx = makeFakeTx(rows);

		const summary = await executeMigrationBatches(tx, plan.candidates, {
			inventoryId,
			mode: "invert",
		});

	expect(summary).toEqual({ converted: 1, alreadyDone: 0 });
	expect(rows.get("cmwnoop")).toMatchObject({ rate: "1.0000000000", migrationOwnerId: inventoryId });
	expect(await executeMigrationBatches(tx, plan.candidates, {
		inventoryId,
		mode: "verify-inverted",
	})).toEqual({ converted: 0, alreadyDone: 1 });
	expect(tx.conditions).toHaveLength(1);
	});

	it("No-op 行字段漂移 → 全字段核对不通过 → 抛错中止", async () => {
		const plan = deriveMigrationPlan([rowOf({ id: "cmwnoop", rate: "1.0000000000" })]);
		const rows = new Map([
			[
				"cmwnoop",
				rowOf({
					id: "cmwnoop",
					rate: "1.0000000000",
					source: "frankfurter", // 冻结后 source 被改
				}),
			],
		]);
		const tx = makeFakeTx(rows);

		await expect(
			executeMigrationBatches(tx, plan.candidates, { inventoryId, mode: "invert" }),
		).rejects.toThrow(/行缺失、冻结字段漂移/);
	});

	it("复跑核对：rate 和行归属匹配但冻结字段漂移 → 抛错中止", async () => {
		const plan = deriveMigrationPlan([
			rowOf({ id: "cmwx3", rate: "4.7567000000" }),
		]);
		// 行 rate 已等于目标值（含并发转换后 observedAt 又被改写的混合漂移）
		const rows = new Map([
			[
				"cmwx3",
				{
					...rowOf({
						id: "cmwx3",
						rate: "0.2102297812",
						observedAt: "2026-09-15T00:09:00.000Z",
					}),
					migrationOwnerId: inventoryId,
				},
			],
		]);
		const tx = makeFakeTx(rows);

		await expect(
			executeMigrationBatches(tx, plan.candidates, { inventoryId, mode: "verify-inverted" }),
		).rejects.toThrow(/冻结字段漂移/);
	});
});

describe("executePlanBatches 组合（FX-06：前批成功、后批漂移 → 调用方事务回滚前批）", () => {
	/** 带回滚语义的假事务包装：$transaction 抛错时恢复执行前快照（模拟 Prisma 回滚）。
	 * 快照必须深拷贝行对象（Map 复制仅拷贝引用，行内 rate 变更无法还原） */
	function makeRollbackTx(rows: Map<string, TestRow>) {
		const inner = makeFakeTx(rows);
		return {
			conditions: inner.conditions,
			$transaction: async <T>(
				callback: (tx: MigrationTx) => Promise<T>,
			): Promise<T> => {
				const snapshot = new Map(
					[...rows].map(([id, row]) => [id, { ...row }]),
				);
				try {
					return await callback(inner);
				} catch (error) {
					// 模拟 Prisma 交互式事务回滚：恢复执行前的全部行状态
					rows.clear();
					for (const [id, row] of snapshot) rows.set(id, row);
					throw error;
				}
			},
		};
	}

	it("er-api 首批命中转换、frankfurter 次批漂移抛错 → 调用方事务回滚前批（er-api 恢复原值，无半写）", async () => {
		const plan = deriveMigrationPlan([
			rowOf({ id: "erapi-1", rate: "4.7567000000" }),
			rowOf({
				id: "ff-1",
				source: "frankfurter",
				base: "USD",
				quote: "MYR",
				rate: "0.6102000000",
			}),
		]);
		const rows = new Map([
			["erapi-1", rowOf({ id: "erapi-1", rate: "4.7567000000" })],
			// frankfurter 行冻结后 observedAt 漂移 → 次批抛错
			[
				"ff-1",
				rowOf({
					id: "ff-1",
					source: "frankfurter",
					base: "USD",
					quote: "MYR",
					rate: "0.6102000000",
					observedAt: "2026-09-15T09:00:00.000Z",
				}),
			],
		]);
		const rollbackTx = makeRollbackTx(rows);

		await expect(
			rollbackTx.$transaction((tx) =>
				executePlanBatches(tx, plan, { inventoryId, mode: "invert" }),
			),
		).rejects.toThrow(/条件未命中/);

		// 前批已转换的 er-api 行被事务回滚恢复为原值（无半写）
		expect(rows.get("erapi-1")?.rate).toBe("4.7567000000");
		expect(rows.get("ff-1")?.rate).toBe("0.6102000000");
	});

	it("双批成功：er-api 与 frankfurter 各自转换，单事务内批序保持（er-api 先行）", async () => {
		const plan = deriveMigrationPlan([
			rowOf({ id: "erapi-1", rate: "4.7567000000" }),
			rowOf({
				id: "ff-1",
				source: "frankfurter",
				base: "USD",
				quote: "MYR",
				rate: "0.6102000000",
			}),
		]);
		const rows = new Map([
			["erapi-1", rowOf({ id: "erapi-1", rate: "4.7567000000" })],
			[
				"ff-1",
				rowOf({
					id: "ff-1",
					source: "frankfurter",
					base: "USD",
					quote: "MYR",
					rate: "0.6102000000",
				}),
			],
		]);
		const rollbackTx = makeRollbackTx(rows);

		const summary = await rollbackTx.$transaction((tx) =>
			executePlanBatches(tx, plan, { inventoryId, mode: "invert" }),
		);

		expect(summary.converted).toBe(2);
		expect(summary.batches["er-api"]).toEqual({ converted: 1, alreadyDone: 0 });
		expect(summary.batches.frankfurter).toEqual({
			converted: 1,
			alreadyDone: 0,
		});
		// 批序断言：er-api 条件先于 frankfurter（§3.3 在事务内保持）
		expect(rollbackTx.conditions.map((condition) => condition.id)).toEqual([
			"erapi-1",
			"ff-1",
		]);
		expect(rows.get("erapi-1")?.rate).toBe("0.2102297812");
		expect(rows.get("ff-1")?.rate).toBe("1.6388069485");
	});
});
