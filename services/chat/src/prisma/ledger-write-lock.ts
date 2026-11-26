import { Prisma } from "@prisma/client";
import { orgWhere, type ReadScope } from "../authorization/organization-scope";

/**
 * 同一组织、币种的账本写入共用事务锁：
 *
 * 账本写路径的唯一加锁入口。原按 `userId` 加锁的 `lockLedgerAccounts` /
 * `lockPlanAccount` 已随 Goal #3B W24（Usage 与 Correction 写路径组织化）移除：
 * 共享账本下按操作者加锁锁不住其他成员的并发写，也不兼容默认组织创建者的
 * 存量行——禁止再引入按 `userId` 的账本锁。
 *
 * 按 currency_code COLLATE "C" 升序取事务级 advisory 锁（账户尚未创建时也有效），
 * 再锁住该组织该币种的账户行，消除同组织成员并发写账本竞态与双行分裂。
 *
 * W30（MIG-E/F）：兼容窗口关闭——`organization_id` 恒非空、账本表已无 `user_id`，
 * 「默认组织创建者的存量 NULL 行」不再存在，故本模块**只**按组织维度加锁，
 * 不再有 defaultOwner 维度的 legacy 锁与 legacy 行收口。
 */
export async function lockOrgLedgerAccounts(
	tx: Prisma.TransactionClient,
	organizationId: string,
	currencyCodes: readonly string[],
): Promise<void> {
	// 锁序不变量：advisory 锁与账户行锁都按币种码二进制序（= COLLATE "C"）依次获取，
	// 改币种更正（旧币种 + 新币种）与单币种写路径以同一全序取锁，不会互相死锁。
	// 排序比较须保持码点序（勿用 localeCompare），与下方 ORDER BY COLLATE "C" 同口径。
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

/** 组织维度的计划账户锁：按组织作用域读取目标币种后调用 lockOrgLedgerAccounts。 */
export async function lockOrgPlanAccount(
	tx: Prisma.TransactionClient,
	scope: ReadScope,
	planId: string,
): Promise<boolean> {
	const plan = await tx.plan.findFirst({
		where: { id: planId, ...orgWhere(scope) },
		select: { targetCurrency: true },
	});
	if (!plan) return false;

	await lockOrgLedgerAccounts(
		tx,
		scope.organizationId,
		[plan.targetCurrency],
	);
	return true;
}

/**
 * 锁内对目标 Plan 行加 FOR UPDATE 行锁（W23 plan.service 先例；W24 抽到锁模块供
 * Usage 写路径共用）：归属条件与组织作用域一致——跨组织 / 不存在
 * 一律返回 false（调用方转 404，不泄露存在性）。
 * 锁序：必须在 lockOrgLedgerAccounts 之后调用（组织锁 → 账户行 → 计划行），
 * 与 plan.service adjust / complete / cancel 及更正的取锁顺序一致。
 */
export async function lockOrgPlanRow(
	tx: Prisma.TransactionClient,
	scope: ReadScope,
	planId: string,
): Promise<boolean> {
	const rows = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT id FROM plans
		WHERE id = ${planId}
			AND organization_id = ${scope.organizationId}
		FOR UPDATE`;
	return rows.length > 0;
}

/**
 * 事务内组织账户更新/建户统一入口：
 * 在调用方已持有 lockOrgLedgerAccounts 的前提下，按
 * (organizationId, currencyCode) 唯一键 upsert 账户行并写回余额。
 *
 * W30（MIG-E/F）：兼容窗口关闭——不再有「legacy 账户行 / NULL 组织行」，
 * 因此不存在双行并存合并、legacy 升级与 P2002 竞态；组织内同币种**恒有且仅有**
 * 一行账户。
 */
export async function upsertOrgAccount(params: {
	tx: Prisma.TransactionClient;
	organizationId: string;
	currencyCode: string;
	actorUserId: string;
	computeBalance: (ctx: {
		existingBalance: Prisma.Decimal;
	}) => Promise<Prisma.Decimal> | Prisma.Decimal;
}): Promise<void> {
	const { tx, organizationId, currencyCode, actorUserId, computeBalance } =
		params;
	const orgAccount = await tx.account.findUnique({
		where: {
			organizationId_currencyCode: { organizationId, currencyCode },
		},
		select: { id: true, balance: true },
	});

	const existingBalance = orgAccount?.balance ?? new Prisma.Decimal(0);
	const balance = await computeBalance({ existingBalance });

	await tx.account.upsert({
		where: {
			organizationId_currencyCode: { organizationId, currencyCode },
		},
		create: {
			organizationId,
			createdById: actorUserId,
			currencyCode,
			balance,
		},
		update: { balance },
	});
}
