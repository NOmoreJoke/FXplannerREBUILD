import { Prisma } from "@prisma/client";
import { resolveDefaultOrganizationCreatorUserId } from "../authorization/default-organization";
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
 * 同一组织、币种的账本写入共用事务锁（ToB R1 W22+ / I-2 防双账户行）：
 * 按 currency_code COLLATE "C" 升序取事务级 advisory 锁（账户尚未创建时也有效），
 * 若当前组织为其创建者的默认组织，按同序同时锁住该创建者（而非仅当前操作者）的
 * 旧 userId 维度 advisory 锁与 organization_id IS NULL 存量账户行，消除受邀成员与
 * 创建者并发写账本竞态、死锁及双行分裂。
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

	const defaultOwnerUserId = await resolveDefaultOrganizationCreatorUserId(
		tx,
		organizationId,
	);
	for (const currencyCode of sorted) {
		const key = `ledger-write:org:${organizationId}:${currencyCode}`;
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
	}
	if (defaultOwnerUserId) {
		for (const currencyCode of sorted) {
			const legacyKey = `ledger-write:${defaultOwnerUserId}:${currencyCode}`;
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${legacyKey}, 0))`;
		}
	}
	await tx.$queryRaw`
		SELECT id FROM accounts
		WHERE organization_id = ${organizationId} AND currency_code = ANY(${sorted}::text[])
		ORDER BY currency_code COLLATE "C"
		FOR UPDATE`;
	if (defaultOwnerUserId) {
		await tx.$queryRaw`
			SELECT id FROM accounts
			WHERE user_id = ${defaultOwnerUserId}
				AND organization_id IS NULL
				AND currency_code = ANY(${sorted}::text[])
			ORDER BY currency_code COLLATE "C"
			FOR UPDATE`;
	}
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

	await lockOrgLedgerAccounts(
		tx,
		scope.organizationId,
		[plan.targetCurrency],
	);
	return true;
}

/** 将默认组织创建者在某币种下遗留的 organizationId: null 账本行收口到当前组织。 */
async function adoptLegacyCurrencyRows(
	tx: Prisma.TransactionClient,
	organizationId: string,
	defaultOwnerUserId: string,
	currencyCode: string,
): Promise<void> {
	await tx.costLot.updateMany({
		where: {
			userId: defaultOwnerUserId,
			organizationId: null,
			currencyCode,
		},
		data: { organizationId },
	});

	const existingOrgHolding = await tx.initialHolding.findUnique({
		where: {
			organizationId_currencyCode: { organizationId, currencyCode },
		},
		select: { id: true },
	});
	if (!existingOrgHolding) {
		await tx.initialHolding.updateMany({
			where: {
				userId: defaultOwnerUserId,
				organizationId: null,
				currencyCode,
				createdById: null,
			},
			data: { organizationId, createdById: defaultOwnerUserId },
		});
		await tx.initialHolding.updateMany({
			where: {
				userId: defaultOwnerUserId,
				organizationId: null,
				currencyCode,
				createdById: { not: null },
			},
			data: { organizationId },
		});
	}

	await tx.transaction.updateMany({
		where: {
			userId: defaultOwnerUserId,
			organizationId: null,
			currencyCode,
			createdById: null,
		},
		data: { organizationId, createdById: defaultOwnerUserId },
	});
	await tx.transaction.updateMany({
		where: {
			userId: defaultOwnerUserId,
			organizationId: null,
			currencyCode,
			createdById: { not: null },
		},
		data: { organizationId },
	});
}

/**
 * 计划写路径专用（I-2）：若当前组织存在默认创建者遗留的 organizationId: null 账户行，
 * 在已持锁的前提下将其与对应 CostLot/InitialHolding/Transaction 一并收口/合并进组织账户，
 * 避免 Owner 与受邀成员在 Plan caps / adjust 上看到分裂余额；若不存在 legacy 账户则零写入。
 */
export async function mergeLegacyOrgAccountIfExists(
	tx: Prisma.TransactionClient,
	organizationId: string,
	currencyCode: string,
): Promise<boolean> {
	const defaultOwnerUserId = await resolveDefaultOrganizationCreatorUserId(
		tx,
		organizationId,
	);
	if (!defaultOwnerUserId) return false;

	const legacyAccount = await tx.account.findFirst({
		where: {
			userId: defaultOwnerUserId,
			organizationId: null,
			currencyCode,
		},
		select: { id: true, balance: true, createdById: true },
	});
	if (!legacyAccount) return false;

	await adoptLegacyCurrencyRows(
		tx,
		organizationId,
		defaultOwnerUserId,
		currencyCode,
	);
	const orgAccount = await tx.account.findUnique({
		where: {
			organizationId_currencyCode: { organizationId, currencyCode },
		},
		select: { id: true, balance: true },
	});
	if (orgAccount) {
		await tx.account.delete({ where: { id: legacyAccount.id } });
		await tx.account.update({
			where: { id: orgAccount.id },
			data: { balance: orgAccount.balance.add(legacyAccount.balance) },
		});
	} else {
		await tx.account.update({
			where: { id: legacyAccount.id },
			data: {
				organizationId,
				createdById: legacyAccount.createdById ?? defaultOwnerUserId,
			},
		});
	}
	return true;
}

/**
 * 事务内组织账户更新/建户统一入口（I-2 防双账户行与 P2002）：
 * 在调用方已持有 lockOrgLedgerAccounts 的前提下：
 * 1. 通过 resolveDefaultOrganizationCreatorUserId 解析组织创建者，而非依赖 actor.isDefaultOrganization；
 * 2. 若创建者有 organizationId: null 的 CostLot / InitialHolding / Transaction / Account，全部收口到本组织；
 * 3. 安全处理三态（双行并存合并删旧 / 仅 legacy 升级 / 无 legacy 直接 upsert），彻底消除 P2002 与余额分裂。
 */
export async function upsertOrgAccountWithLegacyMerge(params: {
	tx: Prisma.TransactionClient;
	organizationId: string;
	currencyCode: string;
	actorUserId: string;
	computeBalance: (ctx: {
		existingBalance: Prisma.Decimal;
		mergedLegacy: boolean;
		defaultOwnerUserId: string | null;
	}) => Promise<Prisma.Decimal> | Prisma.Decimal;
}): Promise<void> {
	const { tx, organizationId, currencyCode, actorUserId, computeBalance } =
		params;
	const defaultOwnerUserId = await resolveDefaultOrganizationCreatorUserId(
		tx,
		organizationId,
	);
	const [orgAccount, legacyAccount] = await Promise.all([
		tx.account.findUnique({
			where: {
				organizationId_currencyCode: { organizationId, currencyCode },
			},
			select: { id: true, balance: true },
		}),
		defaultOwnerUserId
			? tx.account.findFirst({
					where: {
						userId: defaultOwnerUserId,
						organizationId: null,
						currencyCode,
					},
					select: { id: true, balance: true, createdById: true },
				})
			: Promise.resolve(null),
	]);

	if (defaultOwnerUserId) {
		await adoptLegacyCurrencyRows(
			tx,
			organizationId,
			defaultOwnerUserId,
			currencyCode,
		);
	}

	const existingBalance = (orgAccount?.balance ?? new Prisma.Decimal(0)).add(
		legacyAccount?.balance ?? new Prisma.Decimal(0),
	);
	const mergedLegacy = legacyAccount !== null;
	const balance = await computeBalance({
		existingBalance,
		mergedLegacy,
		defaultOwnerUserId,
	});

	if (orgAccount && legacyAccount) {
		await tx.account.delete({ where: { id: legacyAccount.id } });
		await tx.account.update({
			where: { id: orgAccount.id },
			data: { balance },
		});
		return;
	}

	if (!orgAccount && legacyAccount) {
		await tx.account.update({
			where: { id: legacyAccount.id },
			data: {
				organizationId,
				createdById: legacyAccount.createdById ?? defaultOwnerUserId!,
				balance,
			},
		});
		return;
	}

	await tx.account.upsert({
		where: {
			organizationId_currencyCode: { organizationId, currencyCode },
		},
		create: {
			userId: actorUserId,
			organizationId,
			createdById: actorUserId,
			currencyCode,
			balance,
		},
		update: { balance },
	});
}
