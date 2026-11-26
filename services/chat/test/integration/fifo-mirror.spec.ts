/**
 * FIFO 口径镜像测试（fx-checkup 波次 2 · BE-01/BE-02 回归锁定）。
 *
 * 权威口径（已拍板）：增量记账（usage.service → allocateLotsFifo/compareLots）
 * 与更正重放（correction.service → replayCurrencyLedger → compareLedgerEntries）
 * 共享同一比较器：UTC+8 业务日 → INITIAL / PURCHASE / USAGE →
 * 来源记录的 createdAt → 来源记录的 id；INITIAL 批次时间 = 记账起点日；
 * 每片分摊成本按金额列精度 HALF_UP 4 位舍一次（两侧同口径）。
 *
 * 镜像方法：增量事实 = 写路径落库的 UsageLotAllocation / CostLot / Account；
 * 重放事实 = 以同一批 DB 行按 correction 口径构造 LedgerEvent[] 跑纯函数重放；
 * 逐片断言 quantity/cost 相等。
 *
 * 使用发生于批次所在业务日或之后。场景 3 验证补录初始持仓后全量重放的预期重排。
 */
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../src/prisma/prisma.service";
import {
	replayCurrencyLedger,
	type LedgerEvent,
	type ReplayResult,
} from "../../src/correction/ledger-replay";
import { seedInitialHolding } from "../helpers/correction-fixture";
import { seedPlanWithAllocation } from "../helpers/plan-test-helper";
import {
	cleanupUser,
	createTestApp,
	createTestUser,
	orgBearer,
	type TestUser,
} from "../helpers/test-app";

// 关闭全局接口限流（同 usage-fifo-cost.spec：只能 mock ThrottlerGuard 类）
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

/** UTC+8「今天」0 点对应的 UTC 时刻 */
function utc8TodayStartUtc(): number {
	const shifted = Date.now() + 8 * 60 * 60 * 1000;
	return Math.floor(shifted / 86_400_000) * 86_400_000 - 8 * 60 * 60 * 1000;
}

/** 账本起点 = UTC+8 两天前 0 点（UTC 时刻）；day(n) = 起点日 + n 天的上午（UTC+8 10:00 → UTC +2h） */
const LEDGER_START = new Date(utc8TodayStartUtc() - 2 * 86_400_000);
function day(n: number): Date {
	return new Date(LEDGER_START.getTime() + n * 86_400_000 + 2 * 60 * 60 * 1000);
}
/** 第 n+1 个 UTC+8 业务日的起点，晚于第 n 日全部批次。 */
function usageAt(n: number): Date {
	return new Date(LEDGER_START.getTime() + (n + 1) * 86_400_000);
}

/**
 * 以 correction.service 同一口径从 DB 行构造重放事件：
 * INITIAL happenedAt = 账本起点（BE-02 统一，缺起点兜底 confirmedAt）、
 * PURCHASE = transactedAt、USAGE = usedAt。
 */
async function buildEventsFromDb(
	prisma: PrismaService,
	organizationId: string,
	currencyCode: string,
): Promise<LedgerEvent[]> {
	const [holdings, transactions, usages, settings] = await Promise.all([
		prisma.initialHolding.findMany({ where: { organizationId, currencyCode } }),
		prisma.transaction.findMany({ where: { organizationId, currencyCode } }),
		prisma.usageRecord.findMany({ where: { organizationId, currencyCode } }),
		// W30（MIG-F）：记账起点归 OrganizationSettings（组织偏好唯一真相）
		prisma.organizationSettings.findUnique({ where: { organizationId } }),
	]);
	const start = settings?.ledgerStartedAt ?? null;
	const events: LedgerEvent[] = [];
	for (const holding of holdings) {
		events.push({
			type: "INITIAL",
			id: holding.id,
			happenedAt: start ?? holding.confirmedAt,
			createdAt: holding.createdAt,
			quantity: holding.amount,
			unitCost: holding.rate,
			totalCost: holding.cost,
		});
	}
	for (const tx of transactions) {
		events.push({
			type: "PURCHASE",
			id: tx.id,
			happenedAt: tx.transactedAt,
			createdAt: tx.createdAt,
			quantity: tx.quantity,
			principalAmount: tx.principalAmount,
			feeAmount: tx.feeAmount,
		});
	}
	for (const usage of usages) {
		events.push({
			type: "USAGE",
			id: usage.id,
			happenedAt: usage.usedAt,
			createdAt: usage.createdAt,
			quantity: usage.amount,
		});
	}
	return events;
}

interface MirrorSnapshot {
	slices: Array<[string, string, string]>;
}

/** 增量事实：DB 中每笔 usage 的分摊片（lotId → sourceId，裸外键两段解析） */
async function readIncrementalFacts(
	prisma: PrismaService,
	organizationId: string,
	currencyCode: string,
): Promise<Map<string, MirrorSnapshot>> {
	const records = await prisma.usageRecord.findMany({
		where: { organizationId, currencyCode },
	});
	const snapshot = new Map<string, MirrorSnapshot>();
	if (records.length === 0) return snapshot;
	const allocations = await prisma.usageLotAllocation.findMany({
		where: { usageId: { in: records.map((record) => record.id) } },
	});
	const lotRows = await prisma.costLot.findMany({
		where: { id: { in: allocations.map((a) => a.lotId) } },
		select: { id: true, sourceId: true },
	});
	const sourceByLotId = new Map(lotRows.map((lot) => [lot.id, lot.sourceId]));
	for (const record of records) {
		const rows = allocations
			.filter((a) => a.usageId === record.id)
			.sort((a, b) => {
				const sa = sourceByLotId.get(a.lotId) ?? "";
				const sb = sourceByLotId.get(b.lotId) ?? "";
				return sa < sb ? -1 : sa > sb ? 1 : 0;
			});
		snapshot.set(record.id, {
			slices: rows.map((row) => [
				sourceByLotId.get(row.lotId) ?? "",
				row.quantity.toFixed(4),
				row.cost.toFixed(4),
			]),
		});
	}
	return snapshot;
}

/** 重放事实：每笔 usage 的分摊片（同排序规则） */
function readReplayFacts(replay: ReplayResult): Map<string, MirrorSnapshot> {
	const snapshot = new Map<string, MirrorSnapshot>();
	for (const [usageId] of replay.usageCosts) {
		const slices = replay.usageAllocations
			.filter((a) => a.usageId === usageId)
			.map(
				(a) =>
					[a.lotSourceId, a.quantity.toFixed(4), a.cost.toFixed(4)] as [
						string,
						string,
						string,
					],
			)
			.sort((a, b) => (a[0] < b[0] ? -1 : 1));
		snapshot.set(usageId, { slices });
	}
	return snapshot;
}

/** 镜像断言：增量 ≡ 重放（逐片 quantity/cost、每笔总成本、余额、无 V3、批次时刻） */
async function assertMirror(
	prisma: PrismaService,
	organizationId: string,
	currencyCode: string,
	replay: ReplayResult,
	expectedUsageIds?: Set<string>,
): Promise<void> {
	const incremental = await readIncrementalFacts(prisma, organizationId, currencyCode);
	const replayed = readReplayFacts(replay);
	const ids = expectedUsageIds ?? new Set(incremental.keys());
	for (const usageId of ids) {
		const inc = incremental.get(usageId);
		const rep = replayed.get(usageId);
		expect(inc, `usage ${usageId} 增量事实缺失`).toBeDefined();
		expect(rep, `usage ${usageId} 在重放中缺失`).toBeDefined();
		expect(rep!.slices).toEqual(inc!.slices);
		const incTotal = inc!.slices.reduce(
			(sum, [, , cost]) => sum.add(cost),
			new Prisma.Decimal(0),
		);
		expect(replay.usageCosts.get(usageId)!.toFixed(4)).toBe(
			incTotal.toFixed(4),
		);
	}
	// 余额镜像：重放终态 == 账户余额（全量守恒）
	const account = await prisma.account.findFirstOrThrow({
		where: { organizationId, currencyCode },
	});
	expect(replay.finalBalance.toFixed(4)).toBe(account.balance.toFixed(4));
	// 跨日数据下重放不得产生历史时点缺口（BE-02 误报已根治）
	expect(replay.violations).toEqual([]);
	// 批次取得时刻镜像：重放 acquiredAt == DB CostLot.acquiredAt（INITIAL=起点日锁死）
	const dbLots = await prisma.costLot.findMany({
		where: { organizationId, currencyCode },
	});
	const dbBySource = new Map(dbLots.map((lot) => [lot.sourceId, lot]));
	for (const lot of replay.lots) {
		const dbLot = dbBySource.get(lot.sourceId);
		expect(dbLot, `批次 ${lot.sourceId} 缺失`).toBeDefined();
		expect(lot.acquiredAt.getTime()).toBe(dbLot!.acquiredAt.getTime());
	}
}

describe("FIFO 口径镜像（增量 ≡ 重放，BE-01/BE-02 回归）", () => {
	let app: INestApplication;
	let prisma: PrismaService;
	const users: TestUser[] = [];

	function postTx(user: TestUser, body: Record<string, unknown>) {
		return request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgBearer(user))
			.send(body);
	}

	function postUsage(
		user: TestUser,
		planId: string,
		body: Record<string, unknown>,
	) {
		return request(app.getHttpServer())
			.post(`/api/plans/${planId}/usages`)
			.set(orgBearer(user))
			.send(body);
	}

	/** 填法 A 买入体（本金 = 数量 × 单位成本且恰为 2 位小数，unitCost 落库精确不变） */
	function buyA(
		currencyCode: string,
		quantity: string,
		unitCost: string,
		transactedAt: Date,
	) {
		const principal = new Prisma.Decimal(quantity).mul(unitCost);
		expect(principal.decimalPlaces()).toBeLessThanOrEqual(2);
		return {
			currencyCode,
			principalAmount: principal.toFixed(2),
			exchangeRate: unitCost,
			quantity,
			feeAmount: "0",
			transactedAt: transactedAt.toISOString(),
		};
	}

	/** 建用户（账本起点显式指定）并注册清理 */
	async function newUser(label: string): Promise<TestUser> {
		const user = await createTestUser(app, label);
		users.push(user);
		await prisma.userSettings.upsert({
			where: { userId: user.userId },
			update: { locale: "zh-CN", region: "CN" },
			create: { userId: user.userId, locale: "zh-CN", region: "CN" },
		});
		// W30（MIG-F）：本位币与记账起点归 OrganizationSettings
		await prisma.organizationSettings.upsert({
			where: { organizationId: user.defaultOrganizationId },
			update: { baseCurrency: "CNY", ledgerStartedAt: LEDGER_START },
			create: {
				organizationId: user.defaultOrganizationId,
				baseCurrency: "CNY",
				ledgerStartedAt: LEDGER_START,
			},
		});
		return user;
	}

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		prisma = ctx.prisma;
	}, 30_000);

	afterAll(async () => {
		for (const user of users) {
			await cleanupUser(prisma, user.userId);
		}
		await app.close();
	});

	it("场景 1 · 同日多笔买入（后录的 transactedAt 更早）：增量与重放逐片相等", async () => {
		const user = await newUser("mirror-sameday");
		const earlier = day(1);
		const later = new Date(earlier.getTime() + 4 * 60 * 60 * 1000);
		await postTx(user, buyA("USD", "1000", "8", later)).expect(201);
		await postTx(user, buyA("USD", "1000", "7.8", earlier)).expect(201);
		const planId = await seedPlanWithAllocation(prisma, user.userId, {
			targetCurrency: "USD",
			targetAmount: "2000",
			allocatedAmount: "2000",
		});
		const usage = await postUsage(user, planId, {
			amount: "1200",
			usedAt: usageAt(1).toISOString(),
		}).expect(201);
		// 先耗首录买入：1000×8 + 200×7.8
		expect(usage.body.data.usage.cost).toBe("9560.0000");

		const replay = replayCurrencyLedger(
			await buildEventsFromDb(prisma, user.defaultOrganizationId, "USD"),
		);
		await assertMirror(prisma, user.defaultOrganizationId, "USD", replay);
	});

	it("场景 2 · INITIAL 与 PURCHASE 同刻：INITIAL 先耗（type 层），片舍入镜像", async () => {
		const user = await newUser("mirror-mixed");
		// INITIAL 批次时间 = 起点（拍板口径 2；confirmedAt 可晚于 acquiredAt——跨日语义自洽）
		// PURCHASE transactedAt 也取起点 → 两批次同刻，type 层决定 INITIAL 先耗
		const confirmedAt = day(1);

		// rate 4 位小数 × 2 位小数数量 → 本金恰 2 位（unitCost 落库精确），片成本 >4 位触发舍入
		await seedInitialHolding(prisma, {
			userId: user.userId,
			currencyCode: "USD",
			amount: "333.33",
			rate: "7.2483",
			cost: "2416.0758", // 333.33×7.2483=2416.075839 → 4 位 HALF_UP（写侧口径）
			confirmedAt,
			acquiredAt: LEDGER_START,
		});
		await postTx(user, buyA("USD", "500", "7.2483", LEDGER_START)).expect(201);
		const planId = await seedPlanWithAllocation(prisma, user.userId, {
			targetCurrency: "USD",
			targetAmount: "1000",
			allocatedAmount: "1000",
		});
		const usage = await postUsage(user, planId, {
			amount: "600",
			usedAt: usageAt(1).toISOString(),
		}).expect(201);
		// 片1 333.33×7.2483=2416.075839→2416.0758、片2 266.67×7.2483=1932.9041661→1932.9042
		expect(usage.body.data.usage.cost).toBe("4348.9800");

		const replay = replayCurrencyLedger(
			await buildEventsFromDb(prisma, user.defaultOrganizationId, "USD"),
		);
		await assertMirror(prisma, user.defaultOrganizationId, "USD", replay);
	});

	it("场景 3 · 跨日补录初始持仓（BE-02）：INITIAL=起点日锁死、补录后新使用镜像、无 V3", async () => {
		const user = await newUser("mirror-backfill");
		// 起点日：买入 2,000@7.25 → 昨日：使用 1,500（此时初始持仓尚不存在，增量耗 PURCHASE）
		await postTx(user, buyA("USD", "2000", "7.25", day(0))).expect(201);
		const planId = await seedPlanWithAllocation(prisma, user.userId, {
			targetCurrency: "USD",
			targetAmount: "6000",
			allocatedAmount: "3000",
		});
		const usage1 = await postUsage(user, planId, {
			amount: "1500",
			usedAt: usageAt(0).toISOString(),
		}).expect(201);
		expect(usage1.body.data.usage.cost).toBe("10875.0000"); // 1500×7.25

		// 昨日（≠ 起点日）：跨日补录初始持仓（确认时刻昨日；批次取得时刻按 onboarding 写侧口径 = 起点）
		await seedInitialHolding(prisma, {
			userId: user.userId,
			currencyCode: "USD",
			amount: "3000",
			rate: "7.2",
			cost: "21600.0000",
			confirmedAt: day(1),
			acquiredAt: LEDGER_START,
		});

		// 补录后再记账：增量按新批次序（INITIAL acquiredAt=起点排最前）分摊
		const usage2 = await postUsage(user, planId, {
			amount: "500",
			usedAt: usageAt(1).toISOString(),
		}).expect(201);
		expect(usage2.body.data.usage.cost).toBe("3600.0000"); // 500×7.2（先耗起点日 INITIAL）

		const replay = replayCurrencyLedger(
			await buildEventsFromDb(prisma, user.defaultOrganizationId, "USD"),
		);
		// 核心镜像：补录后的新使用（usage2）增量 ≡ 重放逐片相等
		await assertMirror(
			prisma,
			user.defaultOrganizationId,
			"USD",
			replay,
			new Set([usage2.body.data.usage.id]),
		);
		// BE-02 锁定：重放把 INITIAL 事件锚定在起点（而非确认时刻 day3），usage1 重排为先耗
		// INITIAL（补录插队是更正重放的预期全量重算行为；旧口径 INITIAL 排确认日 → 批次漂移）
		const initialLot = replay.lots.find((lot) => lot.sourceType === "INITIAL");
		expect(initialLot!.acquiredAt.getTime()).toBe(LEDGER_START.getTime());
		expect(initialLot!.acquiredAt.getTime()).not.toBe(day(1).getTime());
		const usage1Slices = replay.usageAllocations.filter(
			(a) => a.usageId === usage1.body.data.usage.id,
		);
		expect(usage1Slices).toHaveLength(1);
		expect(usage1Slices[0].lotSourceId).toBe(initialLot!.sourceId); // 重排后耗 INITIAL
		expect(usage1Slices[0].quantity.toFixed(4)).toBe("1500.0000");
		expect(replay.violations).toEqual([]); // 起点日初始批次就位 → 历史时点充足，无误报
	});

	it("场景 4 · 同刻 createdAt 并列：id 兜底两侧同序，逐片相等", async () => {
		const user = await newUser("mirror-sametick");
		const instant = day(1); // 两笔买入同 createdAt 同 transactedAt（id 不同）

		for (const [sourcePrefix, lotPrefix, lotDelayMs, rate] of [
			["a", "z", 10, "7.9"],
			["b", "a", 0, "8.1"],
		] as const) {
			const quantity = "1000";
			const tx = await prisma.transaction.create({
				data: {
					id: `${sourcePrefix}-${user.userId}`,
					organizationId: user.defaultOrganizationId,
					createdById: user.userId,
					currencyCode: "USD",
					principalAmount: new Prisma.Decimal(quantity).mul(rate).toFixed(4),
					exchangeRate: new Prisma.Decimal(rate).toFixed(8),
					// rate 溯源列（rate-refresh-cron 未提交 schema 改动引入的必填列）
					rateSource: "fixture",
					rateObservedAt: instant,
					quantity: new Prisma.Decimal(quantity),
					feeAmount: new Prisma.Decimal(0),
					transactedAt: instant,
					createdAt: instant, // 强制同刻
					updatedAt: instant,
				},
			});
			await prisma.costLot.create({
				data: {
					id: `${lotPrefix}-${user.userId}`,
					organizationId: user.defaultOrganizationId,
					currencyCode: "USD",
					sourceType: "PURCHASE",
					sourceId: tx.id,
					quantity: new Prisma.Decimal(quantity),
					remainingQty: new Prisma.Decimal(quantity),
					unitCost: new Prisma.Decimal(rate),
					totalCost: new Prisma.Decimal(quantity).mul(rate).toFixed(4),
					acquiredAt: instant,
					createdAt: new Date(instant.getTime() + lotDelayMs),
				},
			});
			const existingAccount = await prisma.account.findFirst({
				where: {
					organizationId: user.defaultOrganizationId,
					currencyCode: "USD",
				},
				select: { id: true },
			});
			if (existingAccount) {
				await prisma.account.update({
					where: { id: existingAccount.id },
					data: { balance: { increment: new Prisma.Decimal(quantity) } },
				});
			} else {
				await prisma.account.create({
					data: {
						organizationId: user.defaultOrganizationId,
						createdById: user.userId,
						currencyCode: "USD",
						balance: new Prisma.Decimal(quantity),
					},
				});
			}
		}
		const planId = await seedPlanWithAllocation(prisma, user.userId, {
			targetCurrency: "USD",
			targetAmount: "2000",
			allocatedAmount: "2000",
		});
		const usage = await postUsage(user, planId, {
			amount: "1500",
			usedAt: usageAt(1).toISOString(),
		}).expect(201);
		expect(usage.body.data.usage.cost).toBe("11950.0000");

		const replay = replayCurrencyLedger(
			await buildEventsFromDb(prisma, user.defaultOrganizationId, "USD"),
		);
		// 批次创建时间与 ID 均会把 b 排在前面，来源首录时间相同应按来源 ID 选 a。
		await assertMirror(prisma, user.defaultOrganizationId, "USD", replay);
	});
});
