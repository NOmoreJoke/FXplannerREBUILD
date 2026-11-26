import type { INestApplication } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";
import type { PrismaService } from "../../src/prisma/prisma.service";
import { bearer, cleanupUser, createTestUser, type TestUser } from "./test-app";
import { ensureOnboarded } from "./onboarding-helper";

/**
 * 组织账本测试工具（ToB R1 W24；AGENTS.md：测试工具进 test/helpers，禁止 spec 间复制）。
 *
 * 适用：Usage / Correction 写路径组织化（W24）相关的接口与集成用例——
 * - 造组织：OWNER 的默认组织（已建账）+ 若干指定角色的受邀成员（直插 Membership，
 *   绕开邀请的邮箱 / OTP 链路；角色即权限真源）；
 * - 请求头：鉴权 + X-Organization-Id（+ 可选 X-Request-Id）；
 * - 组织化初始持仓：直插带 organizationId 的持仓 / INITIAL 批次 / 账户（onboarding 接口
 *   依赖实时取价，集成用例不触网）；
 * - 账本快照：按 organizationId 读出可与 toEqual 逐字段比对的纯 JSON 形态；
 * - 清理：先清全部被测组织的派生行与审计（裸外键表 usage_lot_allocations /
 *   plan_allocations 不留孤儿），再删用户；组织随最后一名成员被删而回收，
 *   测后不新增无成员孤儿组织。
 */

export type MemberRole = "ADMIN" | "FINANCE" | "OPERATOR" | "VIEWER";

export interface OrgLedger {
	/** 组织 OWNER：其默认组织即被测组织 */
	owner: TestUser;
	orgId: string;
	/** 受邀成员，与入参 roles 同序 */
	members: TestUser[];
	/** owner + members */
	users: TestUser[];
}

/** 建组织：owner 已建账（本位币 CNY、无记账起点下界），members 按角色依次加入 */
export async function createOrgLedger(
	app: INestApplication,
	prisma: PrismaService,
	label: string,
	roles: readonly MemberRole[] = [],
): Promise<OrgLedger> {
	const owner = await createTestUser(app, `${label}-owner`);
	await ensureOnboarded(prisma, owner.userId);
	const orgId = await resolveDefaultOrganizationId(prisma, owner.userId);
	if (!orgId) {
		throw new Error("注册兜底未建默认组织");
	}
	const members: TestUser[] = [];
	for (const [index, role] of roles.entries()) {
		const member = await createTestUser(
			app,
			`${label}-m${index + 1}-${role.toLowerCase()}`,
		);
		await prisma.membership.create({
			data: { organizationId: orgId, userId: member.userId, role, status: "ACTIVE" },
		});
		members.push(member);
	}
	return { owner, orgId, members, users: [owner, ...members] };
}

/**
 * 给 owner 再建一个组织（owner 同时是两个组织的成员）：用于「多组织用户带 Org B 头
 * 操作 Org A 记录」的跨组织用例。新组织不是 owner 的默认组织（默认组织 = 最早创建的
 * 那个），组织与成员关系同事务创建，与接口建组织的落库形态一致；单独建账。
 */
export async function createSecondOrg(
	prisma: PrismaService,
	owner: TestUser,
	name: string,
): Promise<OrgLedger> {
	const organization = await prisma.organization.create({
		data: {
			name,
			memberships: {
				create: { userId: owner.userId, role: "OWNER", status: "ACTIVE" },
			},
		},
		select: { id: true },
	});
	await prisma.organizationSettings.create({
		data: {
			organizationId: organization.id,
			baseCurrency: "CNY",
			prepPreference: "balanced",
			reminderEnabled: true,
		},
	});
	return { owner, orgId: organization.id, members: [], users: [owner] };
}

/** 鉴权 + 组织上下文请求头（requestId 可选，用于断言审计透传） */
export function orgHeaders(
	user: TestUser,
	orgId: string,
	requestId?: string,
): Record<string, string> {
	return {
		...bearer(user.accessToken),
		"X-Organization-Id": orgId,
		...(requestId ? { "X-Request-Id": requestId } : {}),
	};
}

/** 买入请求体：汇率 = 本金 ÷ 数量（整除，双向自洽恒成立；unitCost 精确可控） */
export function purchaseBody(
	currencyCode: string,
	quantity: string,
	unitCost: string,
	transactedAt: Date,
) {
	const principal = new Prisma.Decimal(quantity).mul(unitCost);
	return {
		currencyCode,
		principalAmount: principal.toFixed(2),
		exchangeRate: new Prisma.Decimal(unitCost).toFixed(8),
		quantity,
		feeAmount: "0",
		transactedAt: transactedAt.toISOString(),
	};
}

/**
 * 组织化初始持仓（模拟 W22 onboarding 写侧落库形态）：InitialHolding + INITIAL 批次 +
 * 账户三行均带 organizationId / createdById。acquiredAt = confirmedAt（无记账起点时
 * 增量 FIFO 与更正重放对 INITIAL 批次时刻同口径）。
 */
export async function seedOrgInitialHolding(
	prisma: PrismaService,
	input: {
		organizationId: string;
		userId: string;
		currencyCode: string;
		amount: string;
		rate: string;
		cost: string;
		confirmedAt: Date;
	},
): Promise<{ holdingId: string; lotId: string }> {
	const amount = new Prisma.Decimal(input.amount);
	const holding = await prisma.initialHolding.create({
		data: {
			organizationId: input.organizationId,
			createdById: input.userId,
			currencyCode: input.currencyCode,
			amount,
			rate: new Prisma.Decimal(input.rate),
			rawRate: new Prisma.Decimal(input.rate),
			rateSource: "fixture",
			rateObservedAt: input.confirmedAt,
			cost: new Prisma.Decimal(input.cost),
			confirmedAt: input.confirmedAt,
		},
	});
	const lot = await prisma.costLot.create({
		data: {
			organizationId: input.organizationId,
			currencyCode: input.currencyCode,
			sourceType: "INITIAL",
			sourceId: holding.id,
			quantity: amount,
			remainingQty: amount,
			unitCost: new Prisma.Decimal(input.rate),
			totalCost: new Prisma.Decimal(input.cost),
			acquiredAt: input.confirmedAt,
		},
	});
	await prisma.account.create({
		data: {
			organizationId: input.organizationId,
			createdById: input.userId,
			currencyCode: input.currencyCode,
			balance: amount,
		},
	});
	return { holdingId: holding.id, lotId: lot.id };
}

/** 账本快照（纯 JSON：Decimal → 定长字符串、Date → ISO；按稳定键排序） */
export interface OrgLedgerSnapshot {
	accounts: Array<{
		id: string;
		/**
		 * 创建者（W30/MIG-E 起账本表不再持有 user_id 列，归属人落在
		 * created_by_id；成员移除后置 NULL，不随用户注销删行）。
		 */
		createdById: string | null;
		organizationId: string;
		currencyCode: string;
		balance: string;
	}>;
	lots: Array<{
		id: string;
		organizationId: string;
		sourceType: string;
		sourceId: string;
		currencyCode: string;
		quantity: string;
		remainingQty: string;
		unitCost: string;
		totalCost: string;
		acquiredAt: string;
	}>;
	usages: Array<{
		id: string;
		createdById: string | null;
		organizationId: string;
		planId: string;
		amount: string;
		usedAt: string;
		version: number;
	}>;
	/** 使用分摊（lotId 解析为来源记录 id，避免批次重建后 id 漂移干扰比对） */
	allocations: Array<{ usageId: string; sourceId: string; quantity: string; cost: string }>;
	planAllocations: Array<{ planId: string; amount: string; usedAmount: string }>;
}

/** 按组织读账本快照：只取 organizationId = orgId 的行（组织化写路径的全部产物） */
export async function readOrgLedgerSnapshot(
	prisma: PrismaService,
	orgId: string,
): Promise<OrgLedgerSnapshot> {
	const [accountRows, lotRows, usageRows, planRows] = await Promise.all([
		prisma.account.findMany({
			where: { organizationId: orgId },
			orderBy: { currencyCode: "asc" },
		}),
		prisma.costLot.findMany({
			where: { organizationId: orgId },
			orderBy: [{ currencyCode: "asc" }, { sourceId: "asc" }],
		}),
		prisma.usageRecord.findMany({
			where: { organizationId: orgId },
			orderBy: [{ usedAt: "asc" }, { id: "asc" }],
		}),
		prisma.plan.findMany({
			where: { organizationId: orgId },
			orderBy: { id: "asc" },
			select: { id: true },
		}),
	]);
	const [planAllocationRows, allocationRows] = await Promise.all([
		prisma.planAllocation.findMany({
			where: { planId: { in: planRows.map((plan) => plan.id) } },
			orderBy: { planId: "asc" },
		}),
		usageRows.length > 0
			? prisma.usageLotAllocation.findMany({
					where: { usageId: { in: usageRows.map((usage) => usage.id) } },
					orderBy: [{ usageId: "asc" }, { lotId: "asc" }],
				})
			: Promise.resolve([]),
	]);
	const lotById = new Map(lotRows.map((lot) => [lot.id, lot]));
	// 分摊明细按账本顺序排列（批次取得时刻 → 初始持仓先于买入 → 数量），与行 id 的字典序无关
	const typeRank = { INITIAL: 0, PURCHASE: 1 };
	const allocations = allocationRows
		.map((row) => {
			const lot = lotById.get(row.lotId);
			return {
				usageId: row.usageId,
				sourceId: lot?.sourceId ?? "<orphan-lot>",
				acquiredAt: lot?.acquiredAt.getTime() ?? 0,
				typeRank: lot ? (typeRank[lot.sourceType as keyof typeof typeRank] ?? 2) : 2,
				quantity: row.quantity,
				cost: row.cost,
			};
		})
		.sort(
			(a, b) =>
				a.acquiredAt - b.acquiredAt ||
				a.typeRank - b.typeRank ||
				a.quantity.comparedTo(b.quantity),
		)
		.map(({ usageId, sourceId, quantity, cost }) => ({
			usageId,
			sourceId,
			quantity: quantity.toFixed(4),
			cost: cost.toFixed(4),
		}));
	return {
		accounts: accountRows.map((account) => ({
			id: account.id,
			createdById: account.createdById,
			organizationId: account.organizationId,
			currencyCode: account.currencyCode,
			balance: account.balance.toFixed(4),
		})),
		lots: lotRows.map((lot) => ({
			id: lot.id,
			organizationId: lot.organizationId,
			sourceType: lot.sourceType,
			sourceId: lot.sourceId,
			currencyCode: lot.currencyCode,
			quantity: lot.quantity.toFixed(4),
			remainingQty: lot.remainingQty.toFixed(4),
			unitCost: lot.unitCost.toFixed(8),
			totalCost: lot.totalCost.toFixed(4),
			acquiredAt: lot.acquiredAt.toISOString(),
		})),
		usages: usageRows.map((usage) => ({
			id: usage.id,
			createdById: usage.createdById,
			organizationId: usage.organizationId,
			planId: usage.planId,
			amount: usage.amount.toFixed(4),
			usedAt: usage.usedAt.toISOString(),
			version: usage.version,
		})),
		allocations,
		planAllocations: planAllocationRows.map((row) => ({
			planId: row.planId,
			amount: row.amount.toFixed(4),
			usedAmount: row.usedAmount.toFixed(4),
		})),
	};
}

/**
 * 快照去掉行 id 与归属人（跨组织比较「同币种同金额」时只比内容：金额、成本、批次时刻、
 * 分摊片、分配额）。两个组织的记录 id、成员 id 天然不同，不参与比较。
 */
export function ledgerShape(snapshot: OrgLedgerSnapshot) {
	return {
		accounts: snapshot.accounts.map((account) => ({
			currencyCode: account.currencyCode,
			balance: account.balance,
		})),
		// 按内容排序（取得时刻 → 类型 → 数量），两个组织的同一份数据必然同序
		lots: snapshot.lots
			.map((lot) => ({
				sourceType: lot.sourceType,
				acquiredAt: lot.acquiredAt,
				quantity: lot.quantity,
				remainingQty: lot.remainingQty,
				unitCost: lot.unitCost,
				totalCost: lot.totalCost,
			}))
			.sort((a, b) =>
				a.acquiredAt.localeCompare(b.acquiredAt) ||
				a.sourceType.localeCompare(b.sourceType) ||
				a.quantity.localeCompare(b.quantity),
			),
		usages: snapshot.usages.map((usage) => ({
			amount: usage.amount,
			usedAt: usage.usedAt,
			version: usage.version,
		})),
		allocations: snapshot.allocations.map((allocation) => ({
			quantity: allocation.quantity,
			cost: allocation.cost,
		})),
		planAllocations: snapshot.planAllocations.map((allocation) => ({
			amount: allocation.amount,
			usedAmount: allocation.usedAmount,
		})),
	};
}

/** 只清组织的派生行与审计（不删用户）：供多组织用例先清完所有组织再删用户 */
async function sweepOrgLedgerRows(
	prisma: PrismaService,
	orgId: string,
): Promise<void> {
	await prisma.$transaction(async (tx) => {
		const scope = { organizationId: orgId };
		const [usageIds, lotIds, planIds] = await Promise.all([
			tx.usageRecord.findMany({ where: scope, select: { id: true } }),
			tx.costLot.findMany({ where: scope, select: { id: true } }),
			tx.plan.findMany({ where: scope, select: { id: true } }),
		]);
		const usageIdList = usageIds.map((row) => row.id);
		const lotIdList = lotIds.map((row) => row.id);
		// 裸外键表必须先于两头删除，否则留下 usage_lot_allocations 孤儿行
		if (usageIdList.length > 0 || lotIdList.length > 0) {
			await tx.usageLotAllocation.deleteMany({
				where: {
					OR: [
						...(usageIdList.length > 0 ? [{ usageId: { in: usageIdList } }] : []),
						...(lotIdList.length > 0 ? [{ lotId: { in: lotIdList } }] : []),
					],
				},
			});
		}
		await tx.correction.deleteMany({ where: scope });
		await tx.usageRecord.deleteMany({ where: scope });
		await tx.costLot.deleteMany({ where: scope });
		const planIdList = planIds.map((row) => row.id);
		if (planIdList.length > 0) {
			await tx.planAllocation.deleteMany({ where: { planId: { in: planIdList } } });
			await tx.planChangeLog.deleteMany({ where: { planId: { in: planIdList } } });
			await tx.plan.deleteMany({ where: { id: { in: planIdList } } });
		}
		await tx.transaction.deleteMany({ where: scope });
		await tx.initialHolding.deleteMany({ where: scope });
		await tx.account.deleteMany({ where: scope });
		// 审计日志无外键，须先于组织显式清理
		await tx.auditLog.deleteMany({ where: { organizationId: orgId } });
	});
}

/**
 * 清理一个或多个被测组织：先清完全部组织的派生行（裸外键不留孤儿），再逐个删用户。
 * 同一用户属于多个组织时也安全——删用户前，其在所有被测组织里的行都已清掉。
 */
export async function cleanupOrgLedgers(
	prisma: PrismaService,
	...orgs: OrgLedger[]
): Promise<void> {
	for (const org of orgs) {
		await sweepOrgLedgerRows(prisma, org.orgId);
	}
	const seen = new Set<string>();
	for (const org of orgs) {
		for (const user of [...org.users].reverse()) {
			if (seen.has(user.userId)) continue;
			seen.add(user.userId);
			// cleanupUser 回收「删掉该用户后不再有成员」的组织（含其审计）
			await cleanupUser(prisma, user.userId);
		}
	}
}
