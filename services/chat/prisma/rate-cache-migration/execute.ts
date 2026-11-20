import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
	executePlanBatches,
	type MigrationExecution,
	type MigrationPlan,
} from "../../src/rate/rate-migration-plan";

/** verifyFrozenPlan 已将圈选集合归一为按 id 排列的重算候选。 */
function checksumOfApprovedScope(plan: MigrationPlan): string {
	const scope = plan.candidates.map(({ row, batch, originalRate, expectedRate }) => [
		row.id,
		row.base,
		row.quote,
		row.source,
		row.sellRate,
		row.observedAt,
		row.createdAt,
		batch,
		originalRate,
		expectedRate,
	]);
	return createHash("sha256")
		.update(JSON.stringify(["rate-cache-migration/v1", scope]))
		.digest("hex");
}

export function requireInventoryId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
	) {
		throw new Error(
			"写入要求新版 inventory 生成的 inventoryId；旧清单仅可预览，旧版转换须按原备份恢复",
		);
	}
	return value;
}

/** 在 CLI 的同一个事务内确认或写入台账，并执行全部批次。 */
export async function executeFrozenPlan(
	tx: Prisma.TransactionClient,
	inventoryId: string,
	plan: MigrationPlan,
	reverse: boolean,
) {
	const receipts = tx.rateCacheMigrationReceipt;
	const scopeChecksum = checksumOfApprovedScope(plan);
	const receipt = await receipts.findUnique({ where: { id: inventoryId } });
	let mode: MigrationExecution["mode"];
	if (receipt === null) {
		if (reverse) {
			throw new Error("找不到该清单的已提交迁移记录，禁止回滚");
		}
		await receipts.create({ data: { id: inventoryId, scopeChecksum } });
		mode = "invert";
	} else {
		if (receipt.scopeChecksum !== scopeChecksum) {
			throw new Error("清单圈选或冻结字段与已提交迁移记录不一致");
		}
		if (receipt.rolledBackAt !== null && !reverse) {
			throw new Error("该清单已回滚；再次转换需重新盘点并圈选");
		}
		if (reverse) {
			mode = receipt.rolledBackAt === null ? "rollback" : "verify-rolled-back";
		} else {
			mode = "verify-inverted";
		}
	}

	const summary = await executePlanBatches(tx.exchangeRate, plan, {
		inventoryId,
		mode,
	});
	if (mode === "rollback") {
		await receipts.update({
			where: { id: inventoryId },
			data: { rolledBackAt: new Date() },
		});
	}
	return summary;
}
