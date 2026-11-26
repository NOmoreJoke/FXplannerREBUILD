/**
 * MIG-B 默认组织回填、MIG-C 快照与 §12.3 一致性核对 CLI（Goal #3A W15 / W29）。
 *
 * 用法（在 services/chat 下，DATABASE_URL 指向**备份副本/演练库**）：
 *   bun prisma/tob-r1-migration/backfill.ts backfill                 # dry-run（默认，只读估算）
 *   bun prisma/tob-r1-migration/backfill.ts backfill --apply --confirm-backup-target
 *                                                                    # 真实写入（双裸旗标缺一不可）
 *   bun prisma/tob-r1-migration/backfill.ts verify                   # §12.3 全量核对，0 diffs 退出 0
 *   bun prisma/tob-r1-migration/backfill.ts snapshot                 # §12.3 七类口径快照（stdout JSON）
 *   bun prisma/tob-r1-migration/backfill.ts drill                    # 快照前后比对（只读演练）
 *   bun prisma/tob-r1-migration/backfill.ts drill --apply --confirm-backup-target
 *                                                                    # 快照 → 回填 → 再快照 → 比对
 *
 * 纪律（沿用 rate-cache-migration 先例）：
 * - 旗标必须为独立裸旗标；带值（空格/等号）、拼写错误、重复、未知旗标一律退出码 1；
 * - JSON 结果输出到 stdout（人类重定向落盘），人类可读提示走 stderr；
 * - **不向仓库写入任何迁移日志或产物文件**：快照/演练结果只进 stdout；
 *   需要落盘时由人类重定向到仓库之外的路径（临时比对文件只放 os.tmpdir() 并清理）；
 * - 写入模式按用户分片事务执行（每片一个事务、幂等可重跑，失败只回滚当前片）；
 *   孤儿派生行预检阻断（BackfillAnomalyError → 退出 1）；
 * - 写入模式拒绝生产目标：库名含 fxplanner_prod（大小写不敏感）或
 *   NODE_ENV=production 一律退出 1（评审 I-15；verify / snapshot / drill 只读，不受此限）；
 * - verify 是迁移时点闸门，须在停写窗口内执行。
 */

import { PrismaClient } from "@prisma/client";
import {
	BackfillAnomalyError,
	backfillDefaultOrganizations,
	isProductionBackfillTarget,
	type BackfillSummary,
} from "../../src/organization/organization-backfill";
import {
	reconcileMigration,
	type ReconcileResult,
} from "../../src/organization/organization-reconcile";
import {
	captureMigrationSnapshot,
	compareMigrationSnapshots,
	type MigrationSnapshot,
	type MigrationSnapshotComparison,
} from "../../src/organization/organization-migration-snapshot";

const USAGE = `用法（DATABASE_URL 必须指向备份副本/演练库）：
  bun prisma/tob-r1-migration/backfill.ts backfill                    # dry-run
  bun prisma/tob-r1-migration/backfill.ts backfill --apply --confirm-backup-target
  bun prisma/tob-r1-migration/backfill.ts verify                      # §12.3 核对
  bun prisma/tob-r1-migration/backfill.ts snapshot                    # §12.3 七类口径快照
  bun prisma/tob-r1-migration/backfill.ts drill                       # 快照前后比对（只读演练）
  bun prisma/tob-r1-migration/backfill.ts drill --apply --confirm-backup-target`;

type Mode =
	| { kind: "backfill-dry" }
	| { kind: "backfill-apply" }
	| { kind: "verify" }
	| { kind: "snapshot" }
	| { kind: "drill"; apply: boolean };

function parseArgs(argv: readonly string[]): Mode {
	if (argv.length === 0) {
		throw new Error(`缺少子命令\n${USAGE}`);
	}
	const [subcommand, ...flags] = argv;
	const knownFlags = new Set(["--apply", "--confirm-backup-target"]);
	for (const flag of flags) {
		if (!knownFlags.has(flag) || flag.includes("=")) {
			throw new Error(`未知或非法旗标: ${flag}\n${USAGE}`);
		}
	}
	if (new Set(flags).size !== flags.length) {
		throw new Error(`旗标重复: ${flags.join(" ")}\n${USAGE}`);
	}
	if (subcommand === "verify") {
		if (flags.length > 0) {
			throw new Error(`verify 不接受旗标\n${USAGE}`);
		}
		return { kind: "verify" };
	}
	if (subcommand === "snapshot") {
		if (flags.length > 0) {
			throw new Error(`snapshot 不接受旗标\n${USAGE}`);
		}
		return { kind: "snapshot" };
	}
	if (subcommand === "backfill" || subcommand === "drill") {
		const apply = flags.includes("--apply");
		const confirm = flags.includes("--confirm-backup-target");
		if (apply !== confirm) {
			throw new Error(
				"写入模式必须同时携带 --apply 与 --confirm-backup-target（人工确认指向备份副本）\n" +
					USAGE,
			);
		}
		if (subcommand === "backfill") {
			return apply ? { kind: "backfill-apply" } : { kind: "backfill-dry" };
		}
		return { kind: "drill", apply };
	}
	throw new Error(`未知子命令: ${subcommand}\n${USAGE}`);
}

async function main(): Promise<number> {
	let mode: Mode;
	try {
		mode = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}

	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		console.error("缺少 DATABASE_URL（指向备份副本/演练库）");
		return 1;
	}
	// 写入模式（backfill --apply / drill --apply）拒绝生产目标；只读子命令不受此限
	const writes =
		mode.kind === "backfill-apply" || (mode.kind === "drill" && mode.apply);
	if (writes && isProductionBackfillTarget(databaseUrl, process.env.NODE_ENV)) {
		// 生产执行不由 AI/本工具自动进行（技术方案 §12.4）
		console.error(
			"拒绝指向生产目标执行写入（库名匹配 fxplanner_prod 或 NODE_ENV=production）；生产停写窗口由人类另行批准",
		);
		return 1;
	}

	const prisma = new PrismaClient();
	try {
		if (mode.kind === "verify") {
			const result: ReconcileResult = await reconcileMigration(prisma);
			console.log(JSON.stringify(result, null, 2));
			if (result.diffs.length > 0) {
				console.error(`核对发现 ${result.diffs.length} 处差异（目标 0 diffs）`);
				return 1;
			}
			console.error(`核对通过：${result.checks} 项检查，0 diffs`);
			console.error(
				"提示：verify 为迁移时点闸门，须在停写窗口内执行；上线后业务数据可在非默认组织演进，不作常驻巡检",
			);
			return 0;
		}

		if (mode.kind === "snapshot") {
			const snapshot: MigrationSnapshot = await captureMigrationSnapshot(prisma);
			console.log(JSON.stringify(snapshot, null, 2));
			console.error(
				`snapshot 完成：7 类口径已采集（归属键口径 ${snapshot.ownerKind}，范围 ${
					snapshot.scoped ? "分片" : "全库"
				}）；结果仅输出到 stdout，请自行重定向到仓库之外`,
			);
			return 0;
		}

		if (mode.kind === "drill") {
			// 迁移前后快照比对（MIG-A → B → C 演练）：采集前快照 → （可选）回填 → 采集后快照 → 比对
			const before = await captureMigrationSnapshot(prisma);
			const summary: BackfillSummary = await backfillDefaultOrganizations(prisma, {
				dryRun: !mode.apply,
			});
			const after = await captureMigrationSnapshot(prisma);
			const comparison: MigrationSnapshotComparison =
				compareMigrationSnapshots(before, after);
			const reconcile: ReconcileResult = await reconcileMigration(prisma);
			console.log(
				JSON.stringify(
					{
						mode: mode.kind,
						applied: mode.apply,
						backfill: summary,
						snapshotComparison: comparison,
						reconcile,
					},
					null,
					2,
				),
			);
			const diffCount = comparison.diffs.length + reconcile.diffs.length;
			if (diffCount > 0) {
				console.error(
					`演练发现 ${diffCount} 处差异（快照 ${comparison.diffs.length} + 核对 ${reconcile.diffs.length}；目标 0）`,
				);
				return 1;
			}
			console.error(
				`演练通过：快照比对 ${comparison.checks} 项、核对 ${reconcile.checks} 项，均 0 差异`,
			);
			return 0;
		}

		const summary: BackfillSummary = await backfillDefaultOrganizations(prisma, {
			dryRun: mode.kind === "backfill-dry",
		});
		console.log(
			JSON.stringify(
				{ mode: mode.kind, ...summary },
				null,
				2,
			),
		);
		console.error(
			mode.kind === "backfill-dry"
				? "dry-run 完成（零写入）；确认后追加 --apply --confirm-backup-target 执行"
				: "MIG-B 回填完成；立即执行 verify 子命令核对（目标 0 diffs）",
		);
		return 0;
	} catch (error) {
		if (error instanceof BackfillAnomalyError) {
			console.error(`${error.message}`);
			console.error(JSON.stringify(error.details, null, 2));
			return 1;
		}
		console.error(error instanceof Error ? error.stack : String(error));
		return 1;
	} finally {
		await prisma.$disconnect();
	}
}

void main().then((code) => {
	process.exitCode = code;
});
