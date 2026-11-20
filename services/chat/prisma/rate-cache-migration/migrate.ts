/**
 * 旧汇率缓存迁移 CLI（MVP-F0-1 B2·迁移演练；实施底稿 §3 五步顺序的工具化）。
 *
 * ⚠ 只允许在【备份副本】上演练；本 CLI 无法验证「备份性」——--apply 必须
 *   显式携带 --confirm-backup-target（人工确认 DATABASE_URL 指向备份副本），
 *   生产 fxplanner_prod 的维护窗口由人类另行批准。
 * 本 CLI 不做任何文件系统操作：冻结清单经 stdout 打印、由 stdin 读回
 * （人类用 shell 重定向/管道落盘与回读）——消除路径穿越面。
 *
 * 命令（在 services/chat 下运行）：
 *   bun run prisma/rate-cache-migration/migrate.ts inventory
 *       只读盘点：读取 exchange_rates 未标记行 → 派生冻结清单（候选/冲突/排除 +
 *       校验和）以 JSON 打印到 stdout（人类重定向落盘）。不产生任何 DB 写入
 *       （底稿 §3 步骤 1）。
 *   bun run prisma/rate-cache-migration/migrate.ts invert [--apply --confirm-backup-target] < frozen.json
 *       原位转换：verifyFrozenPlan 全量校验后按【重算计划】对候选行做
 *       「全冻结字段条件更新」→ 期望新值。批序先 er-api 后 frankfurter
 *       （§3.3），全部候选在【同一计划事务】内执行；缺 --apply 为 dry-run。
 *       转换与完成记录同事务提交。复跑只核对圈选范围、行归属和全冻结字段。
 *   bun run prisma/rate-cache-migration/migrate.ts rollback [--apply --confirm-backup-target] < frozen.json
 *       回滚：凭数据库完成记录和当前行归属，按原圈选范围反向条件更新。
 *
 * 安全语义：
 * - stdin 中的 candidates 永不直接执行——verifyFrozenPlan 与重算计划全量比对
 *   （candidates/conflicts/excludedCount/checksum 四侧一致 + 人工圈选子集校验），
 *   执行侧只用重算计划中 approved 圈选的子集；
 * - 存在冲突行（sellRate 非空 / 非法 / 归零 / 越界 / ErApi 非 TWD）→ 拒绝
 *   --apply（冲突未核实不得放行，底稿 §3.1）；dry-run 仍可查看；
 * 纯函数/执行引擎见 src/rate/rate-migration-plan.ts（含单测与 fast-check 属性）。
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
	deriveMigrationPlan,
	verifyFrozenPlan,
	type InventoryRow,
} from "../../src/rate/rate-migration-plan";
import {
	executeFrozenPlan,
	fingerprintTarget,
	queryTargetIdentity,
	requireInventoryId,
	resolveTargetConnection,
	verifyTargetFingerprint,
} from "./execute";

// 全计划逐行条件更新，幂等复跑还要读取未命中的行。给两批共享一个有限预算。
const MIGRATION_TRANSACTION_TIMEOUT_MS = 30_000;

interface FrozenInventory {
	inventoryId?: string;
	targetFingerprint?: string;
	generatedAt: string;
	note: string;
	/** 人工方向证据圈选的可转换候选 id 集（底稿 §3.1「排除已正确写入行」）；
	 *  inventory 产出时为空数组，人工核对后填入 */
	approvedCandidateIds: string[];
	plan: {
		rows: InventoryRow[];
		candidates: Parameters<typeof verifyFrozenPlan>[0]["candidates"];
		conflicts: Parameters<typeof verifyFrozenPlan>[0]["conflicts"];
		excludedCount: number;
		checksum: string;
	};
}

/** 从 stdin 读取冻结清单 JSON（校验和核对在 verifyFrozenPlan 全量比对中完成） */
async function readFrozenFromStdin(): Promise<FrozenInventory> {
	const chunks: string[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(String(chunk));
	}
	return JSON.parse(chunks.join("")) as FrozenInventory;
}

/** 断连尽力而为：失败如实报告，不改变已达成的事务状态语义 */
async function disconnectQuietly(
	prisma: PrismaClient,
	context?: string,
): Promise<void> {
	try {
		await prisma.$disconnect();
	} catch (disconnectError) {
		console.error(
			context ?? "关闭数据库连接失败（不影响已提交/已回滚状态）：",
			disconnectError,
		);
	}
}

async function main(): Promise<void> {
	const [command, ...flags] = process.argv.slice(2);
	if (
		command !== "inventory" &&
		command !== "invert" &&
		command !== "rollback"
	) {
		console.error(
			"用法：migrate.ts <inventory/invert/rollback> [--apply --confirm-backup-target]" +
				"（清单经 stdout/stdin 管道传递）",
		);
		process.exit(1);
	}

	// 写入确认只认完整的裸旗标；在读取清单或创建客户端前拒绝非法参数。
	const options = new Set(flags);
	if (
		(command === "inventory" && flags.length > 0) ||
		options.size !== flags.length ||
		flags.some((flag) => flag !== "--apply" && flag !== "--confirm-backup-target")
	) {
		console.error(
			"参数无效：inventory 不接收旗标，invert / rollback 仅接受不带值且不重复的 --apply 和 --confirm-backup-target。",
		);
		process.exit(1);
	}

	const apply = options.has("--apply");
	if (apply && !options.has("--confirm-backup-target")) {
		console.error(
			"--apply 需要显式携带 --confirm-backup-target（人工确认 DATABASE_URL " +
				"指向备份副本；生产 fxplanner_prod 的维护窗口由人类另行批准）",
		);
		process.exit(1);
	}

	const databaseUrl = process.env.DATABASE_URL;
	const prisma = new PrismaClient({
		datasourceUrl: databaseUrl,
		transactionOptions: { timeout: MIGRATION_TRANSACTION_TIMEOUT_MS },
	});
	try {
		if (command === "inventory") {
			const connection = resolveTargetConnection(databaseUrl);
			const [, targetIdentity, allRows] = await prisma.$transaction(
				[
					prisma.$executeRaw`SET TRANSACTION READ ONLY`,
					queryTargetIdentity(prisma, connection),
					prisma.exchangeRate.findMany({
						where: { canonicalWriteId: null, migrationOwnerId: null },
						select: {
							id: true,
							base: true,
							quote: true,
							source: true,
							rate: true,
							sellRate: true,
							observedAt: true,
							createdAt: true,
						},
						orderBy: { id: "asc" },
					}),
				],
				{ isolationLevel: "RepeatableRead" },
			);
			const rows: InventoryRow[] = allRows.map((row) => ({
				id: row.id,
				base: row.base,
				quote: row.quote,
				source: row.source,
				// 无参数 toFixed 保留精确数值，并将小数展开为清单要求的十进制文本。
				rate: row.rate.toFixed(),
				sellRate: row.sellRate?.toFixed() ?? null,
				observedAt: row.observedAt.toISOString(),
				createdAt: row.createdAt.toISOString(),
			}));
			const plan = deriveMigrationPlan(rows);
			const frozen: FrozenInventory = {
				inventoryId: randomUUID(),
				targetFingerprint: fingerprintTarget(targetIdentity, connection),
				generatedAt: new Date().toISOString(),
				// 默认空圈选：自动分类只给「可疑候选」，是否确为旧方向由人工
				// 核对方向证据后填入 approvedCandidateIds（防混合旧/新缓存二次取倒数）
				approvedCandidateIds: [],
				note:
					"MVP-F0-1 B2 冻结清单（只读盘点产物）。人工核对候选方向证据并填写 " +
					"approvedCandidateIds 后方可 invert --apply（排除已正确写入行，" +
					"底稿 §3.1）；执行侧 verifyFrozenPlan 与重算计划全量比对通过后才执行，" +
					"候选行转换使用全冻结字段条件更新（幂等复跑 0 更新）。",
				plan,
			};
			// stdout 单行 JSON（人类重定向落盘）；摘要打到 stderr 不污染清单
			process.stdout.write(`${JSON.stringify(frozen)}\n`);
			const byBatch = plan.candidates.reduce(
				(counts, candidate) => {
					counts[candidate.batch] += 1;
					return counts;
				},
				{ "er-api": 0, frankfurter: 0 } as Record<string, number>,
			);
			console.error(
				`盘点完成：总行 ${rows.length}，候选 ${plan.candidates.length}` +
					`（er-api ${byBatch["er-api"]} / frankfurter ${byBatch.frankfurter}），` +
					`冲突 ${plan.conflicts.length}，排除 ${plan.excludedCount}，` +
					`校验和 ${plan.checksum}`,
			);
			await disconnectQuietly(prisma);
			return;
		}

		// invert / rollback：冻结清单从 stdin 读入（管道回读，无文件路径）
		const frozen = await readFrozenFromStdin();
		// 全量防篡改校验（四侧比对 + 圈选子集校验），通过后以【重算计划】的
		// approved 圈选子集执行（stdin 的 candidates 永不直接执行）
		const plan = verifyFrozenPlan({
			...frozen.plan,
			approvedCandidateIds: frozen.approvedCandidateIds,
		});

		if (apply && plan.candidates.length === 0) {
			console.error(
				"approvedCandidateIds 为空（尚未人工圈选任何候选）：自动分类只给可疑候选，" +
					"请在冻结清单 JSON 中人工核对方向证据后填写 approvedCandidateIds" +
					"（排除已正确写入行，底稿 §3.1），再执行 --apply",
			);
			await disconnectQuietly(prisma);
			process.exit(1);
		}

		if (plan.conflicts.length > 0 && apply) {
			// 冲突行未核实不得放行（§3.1）：存在冲突 → 拒绝 --apply（dry-run 仍可查看）
			console.error(
				`存在 ${plan.conflicts.length} 条冲突行（id/原因：` +
					plan.conflicts
						.map((conflict) => `${conflict.id}/${conflict.reason}`)
						.join("、") +
					"），冲突未核实不得放行——请人工核实并重新盘点冻结后再执行",
			);
			await disconnectQuietly(prisma);
			process.exit(1);
		}

		if (!apply) {
			const updates = plan.candidates.map((candidate) => ({
				id: candidate.row.id,
				batch: candidate.batch,
				fromRate:
					command === "rollback"
						? candidate.expectedRate
						: candidate.originalRate,
				toRate:
					command === "rollback"
						? candidate.originalRate
						: candidate.expectedRate,
			}));
			console.log(
				`[dry-run] ${command} 计划 ${updates.length} 条全字段条件更新` +
					`（er-api ${updates.filter((update) => update.batch === "er-api").length} / ` +
					`frankfurter ${updates.filter((update) => update.batch === "frankfurter").length}）；` +
					"加 --apply --confirm-backup-target 在备份副本上事务执行",
			);
			for (const update of updates.slice(0, 20)) {
				console.log(
					`  id=${update.id} [${update.batch}] ${update.fromRate} → ${update.toRate}`,
				);
			}
			await disconnectQuietly(prisma);
			return;
		}

		const inventoryId = requireInventoryId(frozen.inventoryId);
		const connection = resolveTargetConnection(databaseUrl);
		await verifyTargetFingerprint(prisma, connection, frozen.targetFingerprint);
		const reverse = command === "rollback";
		let planSummary: Awaited<ReturnType<typeof executeFrozenPlan>>;
		try {
			planSummary = await prisma.$transaction(
				async (tx) => {
					// 连接池可能为事务分派另一条连接，在首次读取台账前复核。
					await verifyTargetFingerprint(tx, connection, frozen.targetFingerprint);
					return executeFrozenPlan(tx, inventoryId, plan, reverse);
				},
				{ isolationLevel: "Serializable" },
			);
		} catch (error) {
			console.error("计划事务未确认提交，请保留原清单复核：", error);
			await disconnectQuietly(prisma);
			process.exit(1);
		}

		for (const batch of ["er-api", "frankfurter"] as const) {
			const batchSummary = planSummary.batches[batch];
			if (batchSummary.converted + batchSummary.alreadyDone === 0) continue;
			console.error(
				`批次 ${batch}（事务内）：转换 ${batchSummary.converted} / 幂等已达成 ${batchSummary.alreadyDone}`,
			);
		}
		console.log(
			`${command} 完成（单事务已提交）：条件命中转换 ${planSummary.converted}，` +
				`幂等复跑已达成 ${planSummary.alreadyDone}` +
				"（任何候选出现漂移/缺失即抛错 → 整个计划事务回滚，无任何半写）",
		);
		// 断连失败不得谎称回滚：事务已提交，仅连接关闭异常
		await disconnectQuietly(prisma, "事务已提交，但关闭数据库连接失败");
	} catch (error) {
		// 预检或清单解析失败时尚未写入计划数据。
		console.error("迁移失败（未进入计划事务，无写入）：", error);
		await disconnectQuietly(prisma);
		process.exit(1);
	}
}

main().catch((error: unknown) => {
	console.error("迁移进程异常终止：", error);
	process.exit(1);
});
