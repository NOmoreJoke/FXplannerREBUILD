/**
 * MIG-B 默认组织回填与 §12.3 一致性核对 CLI（Goal #3A W15）。
 *
 * 用法（在 services/chat 下，DATABASE_URL 指向**备份副本/演练库**）：
 *   bun prisma/tob-r1-migration/backfill.ts backfill                 # dry-run（默认，只读估算）
 *   bun prisma/tob-r1-migration/backfill.ts backfill --apply --confirm-backup-target
 *                                                                    # 真实写入（双裸旗标缺一不可）
 *   bun prisma/tob-r1-migration/backfill.ts verify                   # §12.3 全量核对，0 diffs 退出 0
 *
 * 纪律（沿用 rate-cache-migration 先例）：
 * - 旗标必须为独立裸旗标；带值（空格/等号）、拼写错误、重复、未知旗标一律退出码 1；
 * - JSON 结果输出到 stdout（人类重定向落盘），人类可读提示走 stderr；
 * - 写入模式按用户分片事务执行（每片一个事务、幂等可重跑，失败只回滚当前片）；
 *   孤儿派生行预检阻断（BackfillAnomalyError → 退出 1）；
 * - 写入模式拒绝生产目标：库名含 fxplanner_prod（大小写不敏感）或
 *   NODE_ENV=production 一律退出 1（评审 I-15；verify 为只读，不受此限）；
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

const USAGE = `用法（DATABASE_URL 必须指向备份副本/演练库）：
  bun prisma/tob-r1-migration/backfill.ts backfill                    # dry-run
  bun prisma/tob-r1-migration/backfill.ts backfill --apply --confirm-backup-target
  bun prisma/tob-r1-migration/backfill.ts verify                      # §12.3 核对`;

type Mode = "backfill-dry" | "backfill-apply" | "verify";

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
		return "verify";
	}
	if (subcommand === "backfill") {
		const apply = flags.includes("--apply");
		const confirm = flags.includes("--confirm-backup-target");
		if (apply !== confirm) {
			throw new Error(
				"写入模式必须同时携带 --apply 与 --confirm-backup-target（人工确认指向备份副本）\n" +
					USAGE,
			);
		}
		return apply ? "backfill-apply" : "backfill-dry";
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
	if (
		mode === "backfill-apply" &&
		isProductionBackfillTarget(databaseUrl, process.env.NODE_ENV)
	) {
		// 生产执行不由 AI/本工具自动进行（技术方案 §12.4）
		console.error(
			"拒绝指向生产目标执行写入（库名匹配 fxplanner_prod 或 NODE_ENV=production）；生产停写窗口由人类另行批准",
		);
		return 1;
	}

	const prisma = new PrismaClient();
	try {
		if (mode === "verify") {
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

		const summary: BackfillSummary = await backfillDefaultOrganizations(
			prisma,
			{ dryRun: mode === "backfill-dry" },
		);
		console.log(
			JSON.stringify(
				{ mode, ...summary },
				null,
				2,
			),
		);
		console.error(
			mode === "backfill-dry"
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
