import { Prisma } from "@prisma/client";
import { resolveDefaultOrganizationCreatorUserId } from "../authorization/default-organization";
import {
	compatReadWhere,
	type ReadScope,
} from "../authorization/organization-scope";

/**
 * 同一组织、币种的账本写入共用事务锁（ToB R1 W22+ / I-2 防双账户行）：
 *
 * 账本写路径的唯一加锁入口。原按 `userId` 加锁的 `lockLedgerAccounts` /
 * `lockPlanAccount` 已随 Goal #3B W24（Usage 与 Correction 写路径组织化）移除：
 * 共享账本下按操作者加锁锁不住其他成员的并发写，也不兼容默认组织创建者的
 * 存量行——禁止再引入按 `userId` 的账本锁。
 *
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
	// 锁序不变量：advisory 锁与账户行锁都按币种码二进制序（= COLLATE "C"）依次获取，
	// 改币种更正（旧币种 + 新币种）与单币种写路径以同一全序取锁，不会互相死锁。
	// 排序比较须保持码点序（勿用 localeCompare），与下方 ORDER BY COLLATE "C" 同口径。
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

/** 收口 CostLot：默认组织创建者在该币种下遗留的 organizationId: null 批次并入当前组织。 */
async function adoptLegacyLots(
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
}

/**
 * 收口 InitialHolding（每币种至多一笔：组织已有该币种持仓时不动存量行）。
 *
 * `preserveUpdatedAt`（Goal #3B W24）：
 * - 缺省 false（W22/W23 写路径的既有行为）：Prisma updateMany，@updatedAt 随之刷新；
 * - true（更正路径）：SQL 直写，updated_at 不变。InitialHolding 没有 version 列，
 *   updatedAt 就是它被更正时的乐观校验基准（baseUpdatedAt）——更正事务若在乐观校验前
 *   顺带刷新了它，成员「预览 → 提交」之间只要有一次账本写入触发收口，提交就会无辜
 *   409 CORRECTION_TARGET_CHANGED。
 */
async function adoptLegacyHoldings(
	tx: Prisma.TransactionClient,
	organizationId: string,
	defaultOwnerUserId: string,
	currencyCode: string,
	{ preserveUpdatedAt = false }: { preserveUpdatedAt?: boolean } = {},
): Promise<void> {
	const existingOrgHolding = await tx.initialHolding.findUnique({
		where: {
			organizationId_currencyCode: { organizationId, currencyCode },
		},
		select: { id: true },
	});
	if (existingOrgHolding) return;

	if (preserveUpdatedAt) {
		await tx.$executeRaw`
			UPDATE initial_holdings
			SET organization_id = ${organizationId}, created_by_id = ${defaultOwnerUserId}
			WHERE user_id = ${defaultOwnerUserId}
				AND organization_id IS NULL
				AND currency_code = ${currencyCode}
				AND created_by_id IS NULL`;
		await tx.$executeRaw`
			UPDATE initial_holdings
			SET organization_id = ${organizationId}
			WHERE user_id = ${defaultOwnerUserId}
				AND organization_id IS NULL
				AND currency_code = ${currencyCode}
				AND created_by_id IS NOT NULL`;
		return;
	}
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

/** 收口 Transaction：同上，并补 createdById。 */
async function adoptLegacyTransactions(
	tx: Prisma.TransactionClient,
	organizationId: string,
	defaultOwnerUserId: string,
	currencyCode: string,
): Promise<void> {
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

/** 将默认组织创建者在某币种下遗留的 organizationId: null 账本行收口到当前组织。 */
async function adoptLegacyCurrencyRows(
	tx: Prisma.TransactionClient,
	organizationId: string,
	defaultOwnerUserId: string,
	currencyCode: string,
	options: { preserveHoldingUpdatedAt?: boolean } = {},
): Promise<void> {
	await adoptLegacyLots(tx, organizationId, defaultOwnerUserId, currencyCode);
	await adoptLegacyHoldings(
		tx,
		organizationId,
		defaultOwnerUserId,
		currencyCode,
		options.preserveHoldingUpdatedAt ? { preserveUpdatedAt: true } : {},
	);
	await adoptLegacyTransactions(
		tx,
		organizationId,
		defaultOwnerUserId,
		currencyCode,
	);
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
 * 锁内对目标 Plan 行加 FOR UPDATE 行锁（W23 plan.service 先例；W24 抽到锁模块供
 * Usage 写路径共用）：归属条件与 compatReadWhere(scope) 同口径——跨组织 / 不存在
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
			AND (
				organization_id = ${scope.organizationId}
				OR (${scope.isDefaultOrganization === true} AND organization_id IS NULL AND user_id = ${scope.userId})
			)
		FOR UPDATE`;
	return rows.length > 0;
}

/**
 * 重放类写路径专用（Goal #3B W24：更正与记使用）：在已持 lockOrgLedgerAccounts 的前提下，
 * **无条件**把默认组织创建者在该币种下遗留的 organizationId: null 账本行收口进本组织——
 * 不以「legacy 账户行存在」为前提（mergeLegacyOrgAccountIfExists 以账户行为锚，覆盖不到
 * 「有账本行、无账户行」的异常存量）。只收口账本行，账户行的合并仍由
 * mergeLegacyOrgAccountIfExists / upsertOrgAccountWithLegacyMerge 负责。
 *
 * 收口范围比 W22/W23 多一类：**使用记录**。共享账本下任何成员都会按组织作用域重放
 * 整个币种的账本（更正）或从同一个 FIFO 池取批次（记使用）——若只并入存量流入（买入 /
 * 持仓）而漏掉存量流出（使用记录），成员发起的重放会少扣这部分使用，写回的余额偏高、
 * 批次剩余偏大（创建者本人因兼容分支能看到自己的存量行，不会发现）。
 *
 * 为什么必须先收口再读账本：更正是「读全量账本 → 重放 → 按重放结果重建批次与余额」。
 * 存量行若留到重放之后才被收口，它们不参与本次重放，却在提交后出现在组织账本里，
 * 余额与批次立刻对不上。调用方须在本函数之后才加载账本上下文。
 *
 * @returns 是否存在默认组织创建者（false = 非默认组织，零写入）
 */
export async function adoptLegacyOrgLedgerRows(
	tx: Prisma.TransactionClient,
	organizationId: string,
	currencyCode: string,
): Promise<boolean> {
	const defaultOwnerUserId = await resolveDefaultOrganizationCreatorUserId(
		tx,
		organizationId,
	);
	if (!defaultOwnerUserId) return false;
	// 只有 W24 路径要求「收口不刷新持仓的 updated_at」；W22/W23 的记交易 / 建账 / 计划
	// 写路径仍走 adoptLegacyCurrencyRows 的既有行为（见 adoptLegacyHoldings）
	await adoptLegacyCurrencyRows(
		tx,
		organizationId,
		defaultOwnerUserId,
		currencyCode,
		{ preserveHoldingUpdatedAt: true },
	);
	// 使用记录同样只改租户列：updated_at 是报告「信息更新时间」的来源，收口不该让一笔
	// 使用看起来像被修改过
	await tx.$executeRaw`
		UPDATE usage_records
		SET organization_id = ${organizationId}, created_by_id = ${defaultOwnerUserId}
		WHERE user_id = ${defaultOwnerUserId}
			AND organization_id IS NULL
			AND currency_code = ${currencyCode}
			AND created_by_id IS NULL`;
	await tx.$executeRaw`
		UPDATE usage_records
		SET organization_id = ${organizationId}
		WHERE user_id = ${defaultOwnerUserId}
			AND organization_id IS NULL
			AND currency_code = ${currencyCode}
			AND created_by_id IS NOT NULL`;
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
