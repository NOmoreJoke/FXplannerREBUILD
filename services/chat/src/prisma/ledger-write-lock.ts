import { Prisma } from "@prisma/client";
import {
	compatReadWhere,
	type ReadScope,
} from "../authorization/organization-scope";

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

/**
 * 同一组织、币种的账本写入共用事务锁（ToB R1 W22+）：
 * 按 currency_code COLLATE "C" 升序取事务级 advisory 锁（账户尚未创建时也有效），
 * 再按同序 FOR UPDATE 锁定已有组织账户行，消除多成员并发写账本竞态与死锁。
 */
export async function lockOrgLedgerAccounts(
	tx: Prisma.TransactionClient,
	organizationId: string,
	currencyCodes: readonly string[],
): Promise<void> {
	const sorted = [...new Set(currencyCodes)].sort((a, b) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	if (sorted.length === 0) return;

	for (const currencyCode of sorted) {
		const key = `ledger-write:org:${organizationId}:${currencyCode}`;
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
	}
	await tx.$queryRaw`
		SELECT id FROM accounts
		WHERE organization_id = ${organizationId} AND currency_code = ANY(${sorted}::text[])
		ORDER BY currency_code COLLATE "C"
		FOR UPDATE`;
}

/** 组织维度的计划账户锁：按 compatReadWhere(scope) 读取目标币种后调用 lockOrgLedgerAccounts。 */
export async function lockOrgPlanAccount(
	tx: Prisma.TransactionClient,
	scope: ReadScope,
	planId: string,
): Promise<boolean> {
	const plan = await tx.plan.findFirst({
		where: { id: planId, ...compatReadWhere(scope) },
		select: { targetCurrency: true },
	});
	if (!plan) return false;

	await lockOrgLedgerAccounts(tx, scope.organizationId, [plan.targetCurrency]);
	return true;
}
