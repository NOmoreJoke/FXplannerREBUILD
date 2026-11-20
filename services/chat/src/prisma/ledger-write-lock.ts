import { Prisma } from "@prisma/client";

/**
 * 同一用户、币种的计划与账本写入共用事务锁。先按币种排序取 advisory 锁（账户
 * 尚未创建时也有效），再锁已有账户行，与更新该行余额的买入事务互斥。
 * 调用方在此之后才读取业务状态并更新计划、分配或账本。
 */
export async function lockLedgerAccounts(
	tx: Prisma.TransactionClient,
	userId: string,
	currencyCodes: readonly string[],
): Promise<void> {
	const sorted = [...new Set(currencyCodes)].sort();
	for (const currencyCode of sorted) {
		const key = `ledger-write:${userId}:${currencyCode}`;
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
	}
	await tx.$queryRaw`
		SELECT id FROM accounts
		WHERE user_id = ${userId} AND currency_code IN (${Prisma.join(sorted)})
		ORDER BY currency_code COLLATE "C"
		FOR UPDATE`;
}

/** 锁前只读取不可调整的目标币种用于路由。调用方持锁后再读取计划现状。 */
export async function lockPlanAccount(
	tx: Prisma.TransactionClient,
	userId: string,
	planId: string,
): Promise<boolean> {
	const plan = await tx.plan.findFirst({
		where: { id: planId, userId },
		select: { targetCurrency: true },
	});
	if (!plan) return false;

	await lockLedgerAccounts(tx, userId, [plan.targetCurrency]);
	return true;
}
