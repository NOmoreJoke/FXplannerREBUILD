import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../src/prisma/prisma.service";
import type { MigrationPlan } from "../../src/rate/rate-migration-plan";
import { RateProvider } from "../../src/rate/rate.provider";
import { RateService } from "../../src/rate/rate.service";
import {
	createRateSourceFetchStub,
	erApiLatestBody,
	frankfurterTimeSeriesBody,
	jsonResponse,
	parseFrankfurterTimeSeriesRange,
} from "../helpers/rate-source-fixtures";

interface Inventory {
	inventoryId?: string;
	targetFingerprint?: string;
	approvedCandidateIds: string[];
	plan: MigrationPlan;
}

describe("旧汇率缓存 CLI 与 PostgreSQL 完成记录", () => {
	const prisma = new PrismaClient();
	const fixtureIds: string[] = [];
	const inventoryIds: string[] = [];
	const observedAt = new Date("2041-01-01T00:00:00.000Z");
	const createdAt = new Date("2041-01-01T00:09:42.123Z");
	const cli = "prisma/rate-cache-migration/migrate.ts";
	let inventory: Inventory;
	let a: string;
	let b: string;
	let noChange: string;

	function run(
		command: "inventory" | "invert" | "rollback",
		input?: Inventory,
		apply = true,
	) {
		const flags = input && apply ? ["--apply", "--confirm-backup-target"] : [];
		const result = spawnSync("bun", ["run", cli, command, ...flags], {
			encoding: "utf8",
			input: input && JSON.stringify(input),
		});
		if (result.error) throw result.error;
		return result;
	}

	function check(result: ReturnType<typeof run>, status: number, message: RegExp) {
		const output = result.stdout + result.stderr;
		expect(result.status, output).toBe(status);
		expect(output).toMatch(message);
	}

	function snapshot() {
		return prisma.exchangeRate.findMany({
			where: { id: { in: fixtureIds } },
			orderBy: { id: "asc" },
		});
	}

	function receipt(id = inventory.inventoryId!) {
		return prisma.rateCacheMigrationReceipt.findUnique({ where: { id } });
	}

	async function seed(
		base: string, quote: string, source: string, rate: string, sellRate?: string,
		at = observedAt, confirmedAt = createdAt,
	) {
		const row = await prisma.exchangeRate.create({
			data: { base, quote, source, rate, sellRate, observedAt: at, createdAt: confirmedAt },
		});
		fixtureIds.push(row.id);
		return row.id;
	}

	beforeEach(async () => {
		a = await seed("CNY", "TWD", "er-api", "4.7567");
		b = await seed("USD", "MYR", "frankfurter", "0.2");
		noChange = await seed("USD", "EUR", "frankfurter", "1");
		await seed("CNY", "USD", "abc", "7", "7.1");
		const result = run("inventory");
		check(result, 0, /盘点完成/);
		inventory = JSON.parse(result.stdout);
		expect(inventory.inventoryId).toBeDefined();
		expect(inventory.targetFingerprint).toMatch(/^[a-f0-9]{64}$/);
		inventoryIds.push(inventory.inventoryId!);
		inventory.approvedCandidateIds = [a, b];
	});

	afterEach(async () => {
		vi.useRealTimers();
		await prisma.exchangeRate.deleteMany({ where: { id: { in: fixtureIds } } });
		await prisma.rateCacheMigrationReceipt.deleteMany({
			where: { id: { in: inventoryIds } },
		});
		fixtureIds.length = 0;
		inventoryIds.length = 0;
	});

	afterAll(() => prisma.$disconnect());

	it.each([
		["0.00000001", "100000000", "100000000.0000000000"],
		["100000000", "0.00000001", "0.0000000100"],
	])("用同一份清单转换 %s → %s 并逐字段回滚", async (rate, inverted, expectedRate) => {
		const id = await seed("HKD", "TWD", "er-api", rate);
		const result = run("inventory");
		check(result, 0, /盘点完成/);
		const frozen: Inventory = JSON.parse(result.stdout);
		expect(frozen.inventoryId).toBeDefined();
		inventoryIds.push(frozen.inventoryId!);
		expect(frozen.plan.conflicts).toEqual([]);
		expect(frozen.plan.candidates).toContainEqual(
			expect.objectContaining({
				row: expect.objectContaining({ id, rate }),
				originalRate: rate,
				expectedRate,
			}),
		);
		frozen.approvedCandidateIds = [id];

		const before = await snapshot();
		check(run("invert", frozen), 0, /转换 1，幂等复跑已达成 0/);
		const applied = await snapshot();
		expect(applied.find((row) => row.id === id)?.rate.toFixed()).toBe(inverted);
		expect(applied).toEqual(before.map((row) => row.id === id ? {
			...row,
			rate: applied.find((candidate) => candidate.id === id)!.rate,
			migrationOwnerId: frozen.inventoryId,
		} : row));

		check(run("invert", frozen), 0, /转换 0，幂等复跑已达成 1/);
		expect(await snapshot()).toEqual(applied);
		check(run("rollback", frozen), 0, /转换 1，幂等复跑已达成 0/);
		expect(await snapshot()).toEqual(before);
		check(run("rollback", frozen), 0, /转换 0，幂等复跑已达成 1/);
		expect(await snapshot()).toEqual(before);
	});

	describe("已提交的圈选", () => {
		let before: Awaited<ReturnType<typeof snapshot>>;
		let applied: typeof before;
		let committed: Awaited<ReturnType<typeof receipt>>;

		beforeEach(async () => {
			before = await snapshot();
			check(run("invert", inventory), 0, /转换 2，幂等复跑已达成 0/);
			applied = await snapshot();
			committed = await receipt();
			expect(committed).not.toBeNull();
		});

		it("拒绝缩小、扩大或修改已提交的冻结字段", async () => {
			for (const approvedCandidateIds of [[b], [a, b, noChange]]) {
				check(run("rollback", { ...inventory, approvedCandidateIds }), 1, /圈选或冻结字段/);
			}
			const tampered = structuredClone(inventory);
			const forgedTimestamp = "2041-01-01T00:10:00.000Z";
			tampered.plan.rows.find(({ id }) => id === b)!.createdAt = forgedTimestamp;
			tampered.plan.candidates.find(({ row }) => row.id === b)!.row.createdAt = forgedTimestamp;
			check(run("rollback", tampered), 1, /圈选或冻结字段/);
			expect(await snapshot()).toEqual(applied);
			expect(await receipt()).toEqual(committed);
		});

		it("清单重排后复跑零写入，合法回滚逐字段恢复原快照", async () => {
			expect(applied).toEqual(before.map((row) => {
				if (row.id === a || row.id === b) {
					return {
						...row,
						rate: expect.anything(),
						migrationOwnerId: inventory.inventoryId,
					};
				}
				return row;
			}));
			expect(applied.find(({ id }) => id === a)?.rate.toString()).toBe("0.2102297812");
			expect(applied.find(({ id }) => id === b)?.rate.toString()).toBe("5");
			check(run("invert", { ...inventory, approvedCandidateIds: [b, a] }),
				0, /转换 0，幂等复跑已达成 2/);
			expect(await snapshot()).toEqual(applied);
			expect(await receipt()).toEqual(committed);

			check(run("rollback", inventory), 0, /转换 2，幂等复跑已达成 0/);
			expect(await snapshot()).toEqual(before);
			expect((await receipt())?.rolledBackAt).toBeInstanceOf(Date);
		});

		it("回滚复跑零写入，同一清单不能再次转换", async () => {
			check(run("rollback", inventory), 0, /转换 2，幂等复跑已达成 0/);
			const rolledBack = await receipt();
			expect(rolledBack?.rolledBackAt).toBeInstanceOf(Date);
			check(run("rollback", inventory), 0, /转换 0，幂等复跑已达成 2/);
			check(run("invert", inventory), 1, /该清单已回滚/);
			expect(await snapshot()).toEqual(before);
			expect(await receipt()).toEqual(rolledBack);
		});

		it("同值覆盖让行失去归属，复跑和回滚拒绝并保持整批快照", async () => {
			const otherInventory = { ...inventory, inventoryId: randomUUID() };
			inventoryIds.push(otherInventory.inventoryId);
			check(run("rollback", otherInventory), 1, /找不到该清单的已提交迁移记录/);

			await prisma.exchangeRate.update({ where: { id: b }, data: { rate: "5" } });
			const overwritten = await snapshot();
			expect(overwritten.find(({ id }) => id === b)?.migrationOwnerId).toBeNull();
			check(run("invert", inventory), 1, /迁移归属不匹配/);
			check(run("rollback", inventory), 1, /迁移归属不匹配/);
			expect(await snapshot()).toEqual(overwritten);
			expect(await receipt()).toEqual(committed);
		});
	});

	it("拒绝认领外部写入的同值行，先前批次和暂建完成记录一起回滚", async () => {
		await prisma.exchangeRate.update({ where: { id: b }, data: { rate: "5" } });
		const before = await snapshot();
		check(run("rollback", inventory), 1, /找不到该清单的已提交迁移记录/);
		check(run("invert", inventory), 1, /条件未命中/);
		expect(await snapshot()).toEqual(before);
		expect(await receipt()).toBeNull();
		check(run("rollback", inventory), 1, /找不到该清单的已提交迁移记录/);
	});

	it("旧清单只可预览", async () => {
		const before = await snapshot();
		for (const legacy of [
			{ ...inventory, inventoryId: undefined },
			{ ...inventory, targetFingerprint: undefined },
		]) {
			for (const command of ["invert", "rollback"] as const) {
				check(run(command, legacy, false), 0, /dry-run/);
				check(run(command, legacy), 1, /未进入计划事务，无写入.*旧清单仅可预览/s);
			}
		}
		expect(await receipt()).toBeNull();
		expect(await snapshot()).toEqual(before);
	});

	it("目标指纹与当前连接不符时，在写事务前拒绝转换与回滚", async () => {
		const before = await snapshot();
		const fingerprint = inventory.targetFingerprint!;
		const foreign = {
			...inventory,
			targetFingerprint: (fingerprint[0] === "0" ? "1" : "0") + fingerprint.slice(1),
		};
		for (const command of ["invert", "rollback"] as const) {
			check(
				run(command, foreign),
				1,
				/未进入计划事务，无写入.*目标副本与当前连接不一致/s,
			);
		}
		expect(await receipt()).toBeNull();
		expect(await snapshot()).toEqual(before);
	});

	it("数值不变的圈选也获得归属，回滚撤销方向证据", async () => {
		const before = await snapshot();
		inventory.approvedCandidateIds = [noChange];
		check(run("invert", inventory), 0, /转换 1，幂等复跑已达成 0/);
		const unchanged = await prisma.exchangeRate.findUniqueOrThrow({ where: { id: noChange } });
		expect(unchanged.rate.toString()).toBe("1");
		expect(unchanged.migrationOwnerId).toBe(inventory.inventoryId);
		check(run("invert", inventory), 0, /转换 0，幂等复跑已达成 1/);
		expect(await receipt()).not.toBeNull();
		check(run("rollback", inventory), 0, /转换 1，幂等复跑已达成 0/);
		expect((await receipt())?.rolledBackAt).toBeInstanceOf(Date);
		expect(await snapshot()).toEqual(before);
	});

	it("已提交的 v1 清单沿用旧版核对和回滚，无凭据的数值不变行保持未认领", async () => {
		const candidate = inventory.plan.candidates.find(({ row }) => row.id === noChange)!;
		const { row, batch, originalRate, expectedRate } = candidate;
		const scope = [[
			row.id, row.base, row.quote, row.source, row.sellRate, row.observedAt,
			row.createdAt, batch, originalRate, expectedRate,
		]];
		const scopeChecksum = createHash("sha256")
			.update(JSON.stringify(["rate-cache-migration/v1", scope]))
			.digest("hex");
		await prisma.rateCacheMigrationReceipt.create({
			data: { id: inventory.inventoryId!, scopeChecksum },
		});
		const before = await snapshot();
		inventory.approvedCandidateIds = [noChange];
		check(run("invert", inventory), 0, /转换 0，幂等复跑已达成 1/);
		check(run("rollback", inventory), 0, /转换 0，幂等复跑已达成 1/);
		expect((await receipt())?.rolledBackAt).toBeInstanceOf(Date);
		expect(await snapshot()).toEqual(before);
	});

	function utcDay(daysAgo: number) {
		const day = new Date();
		day.setUTCHours(0, 0, 0, 0);
		day.setUTCDate(day.getUTCDate() - daysAgo);
		return day;
	}

	const dateOnly = (timestamp: Date) => timestamp.toISOString().slice(0, 10);

	it("混合同币对的 latest、SWR、history 和日级原时点只读有方向证据的版本", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const base = "SGD";
		const quote = "TWD";
		const oldAt = utcDay(1);
		const currentAt = utcDay(3);
		const approved = await seed(base, quote, "er-api", "0.625", undefined, oldAt, new Date());
		const unknown = await seed(base, quote, "er-api", "1.6", undefined, utcDay(2));
		const abcAt = utcDay(2);
		await seed("SGD", "HKD", "abc", "0.2", "0.21", abcAt, new Date());
		await seed(base, base, "identity", "1", undefined, abcAt, new Date());

		let available = false;
		const upstream = createRateSourceFetchStub({
			erApi: () => available
				? jsonResponse(erApiLatestBody({ TWD: "0.625" }, currentAt.getTime() / 1000))
				: new Response(null, { status: 503 }),
		});
		const rates = new RateService(
			prisma as PrismaService,
			new RateProvider(undefined, upstream as unknown as typeof fetch),
		);
		try {
			await expect(rates.getLatest(base, [quote])).rejects.toMatchObject({ status: 502 });
			expect((await rates.getHistory(base, quote, 7)).data_points).toEqual([]);
			expect(await rates.findQuoteAt(base, quote, oldAt)).toBeNull();
			expect(await rates.getLatest(base, ["HKD"])).toMatchObject({ rate: "0.2", sellRate: "0.21" });
			expect(await rates.getLatest(base, [base])).toMatchObject({ rate: "1", source: "identity" });
			expect(await rates.findQuoteAt(base, "HKD", abcAt)).toMatchObject({ rate: "0.2", sellRate: "0.21" });

			available = true;
			expect(await rates.getLatest(base, [quote])).toMatchObject({ rate: "1.6", fresh: true });
			const firstWrite = await prisma.exchangeRate.findUniqueOrThrow({
				where: { base_quote_observedAt: { base, quote, observedAt: currentAt } },
			});
			fixtureIds.push(firstWrite.id);
			expect(firstWrite.canonicalWriteId).toEqual(expect.any(String));
			expect(await rates.getLatest(base, [quote], true)).toMatchObject({ rate: "1.6", fresh: true });
			const written = await prisma.exchangeRate.findUniqueOrThrow({ where: { id: firstWrite.id } });
			expect(written.canonicalWriteId).toEqual(expect.any(String));
			expect(written.canonicalWriteId).not.toBe(firstWrite.canonicalWriteId);

			available = false;
			expect(await rates.getLatest(base, [quote])).toMatchObject({
				rate: "1.6", observedAt: currentAt.toISOString(), fresh: true,
			});
			expect(written.latestConfirmedAt).toBeInstanceOf(Date);
			const staleBoundary = written.latestConfirmedAt!.getTime() + 300_000;
			const stale = vi.spyOn(Date, "now").mockReturnValue(staleBoundary);
			try {
				expect(await rates.getLatest(base, [quote])).toMatchObject({
					rate: "1.6", observedAt: currentAt.toISOString(), fresh: false,
				});
			} finally {
				stale.mockRestore();
			}
			const currentPoint = { date: dateOnly(currentAt), rate: "1.6", source: "er-api" };
			const migratedPoint = { date: dateOnly(oldAt), rate: "1.6", source: "er-api" };
			expect((await rates.getHistory(base, quote, 7)).data_points).toEqual([currentPoint]);
			// 新行超过 5 分钟仍可用于日级回看，方向未知的较新行不能优先。
			expect(await rates.findQuoteAt(base, quote, oldAt)).toMatchObject({
				rate: "1.6", observedAt: currentAt,
			});

			const frozen = run("inventory");
			check(frozen, 0, /盘点完成/);
			const approvedInventory: Inventory = JSON.parse(frozen.stdout);
			inventoryIds.push(approvedInventory.inventoryId!);
			const candidateIds = approvedInventory.plan.candidates.map(({ row }) => row.id);
			expect(candidateIds).toContain(approved);
			expect(candidateIds).toContain(unknown);
			expect(candidateIds).not.toContain(written.id);
			approvedInventory.approvedCandidateIds = [approved];
			check(run("invert", approvedInventory), 0, /转换 1，幂等复跑已达成 0/);
			const afterApply = await snapshot();
			expect(await rates.getLatest(base, [quote])).toMatchObject({
				rate: "1.6", observedAt: currentAt.toISOString(), fresh: true,
			});
			const migrated = await prisma.exchangeRate.findUniqueOrThrow({ where: { id: approved } });
			expect(migrated).toMatchObject({
				migrationOwnerId: approvedInventory.inventoryId,
				latestConfirmedAt: null,
			});
			const staleAfterMigration = vi.spyOn(Date, "now").mockReturnValue(staleBoundary);
			try {
				expect(await rates.getLatest(base, [quote])).toMatchObject({
					rate: "1.6", observedAt: currentAt.toISOString(), fresh: false,
				});
			} finally {
				staleAfterMigration.mockRestore();
			}
			expect((await rates.getHistory(base, quote, 7)).data_points).toEqual([currentPoint, migratedPoint]);
			expect(await rates.findQuoteAt(base, quote, oldAt)).toMatchObject({ rate: "1.6", observedAt: oldAt });
			check(run("invert", approvedInventory), 0, /转换 0，幂等复跑已达成 1/);
			expect(await snapshot()).toEqual(afterApply);
			check(run("rollback", approvedInventory), 0, /转换 1，幂等复跑已达成 0/);
			expect((await rates.getHistory(base, quote, 7)).data_points).toEqual([currentPoint]);
			expect(await rates.findQuoteAt(base, quote, oldAt)).toMatchObject({ rate: "1.6", observedAt: currentAt });
		} finally {
			await prisma.exchangeRate.deleteMany({ where: { base, quote } });
		}
	});

	it("原时点和图表的回补修复无证同键，保留有证点及日期级限制", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const base = "CAD";
		const quote = "MYR";
		const prior = utcDay(2);
		const recent = utcDay(1);
		const today = utcDay(0);
		const priorId = await seed(base, quote, "frankfurter", "0.625", undefined, prior);
		const recentId = await seed(base, quote, "frankfurter", "0.5", undefined, recent);
		const upstream = createRateSourceFetchStub({
			frankfurter: (href) => {
				const range = parseFrankfurterTimeSeriesRange(href);
				if (!range) return new Response(null, { status: 503 });
				const values = [
					[dateOnly(prior), range.end === dateOnly(prior) ? "0.625" : "0.25"],
					[dateOnly(recent), "0.5"],
					[dateOnly(today), "2.5"],
				];
				return jsonResponse(frankfurterTimeSeriesBody(Object.fromEntries(
					values.filter(([day]) => day >= range.start && day <= range.end)
						.map(([day, raw]) => [day, { [quote]: raw }]),
				)));
			},
		});
		const rates = new RateService(
			prisma as PrismaService,
			new RateProvider(undefined, upstream as unknown as typeof fetch),
		);
		try {
			expect(await rates.findQuoteAt(base, quote, prior)).toBeNull();
			const refreshed = await prisma.exchangeRate.findUniqueOrThrow({ where: { id: priorId } });
			expect(refreshed.rate.toString()).toBe("1.6");
			expect(refreshed.canonicalWriteId).toEqual(expect.any(String));
			const history = await rates.getHistory(base, quote, 7);
			expect(history.data_points.map(({ date, rate }) => [date, rate])).toEqual([
				[dateOnly(prior), "1.6"], [dateOnly(recent), "2"], [dateOnly(today), "0.4"],
			]);
			const saved = await prisma.exchangeRate.findMany({ where: { base, quote }, orderBy: { observedAt: "asc" } });
			expect(saved.map(({ rate }) => rate.toString())).toEqual(["1.6", "2", "0.4"]);
			expect(saved[0]).toEqual(refreshed);
			expect(saved[1]).toMatchObject({ id: recentId, canonicalWriteId: expect.any(String) });
			expect(saved[2].canonicalWriteId).toEqual(expect.any(String));
			// 模拟旧版写入者覆盖当前行，即使值相等，旧方向证据也不可继承。
			await prisma.exchangeRate.update({ where: { id: saved[2].id }, data: { rate: "0.4" } });
			expect((await prisma.exchangeRate.findUniqueOrThrow({ where: { id: saved[2].id } })).canonicalWriteId).toBeNull();
			expect((await rates.getHistory(base, quote, 7)).data_points.map(({ rate }) => rate)).toEqual(["1.6", "2"]);
		} finally {
			await prisma.exchangeRate.deleteMany({ where: { base, quote } });
		}
	});

	it("冻结后同值的可信写入使旧清单失效，CLI 不会二次取倒数", async () => {
		await prisma.exchangeRate.update({ where: { id: a }, data: { canonicalWriteId: randomUUID() } });
		const before = await snapshot();
		check(run("invert", inventory), 1, /条件未命中/);
		expect(await receipt()).toBeNull();
		expect(await snapshot()).toEqual(before);
	});

	it("ABC 同键回源缺卖出价时清除旧非 ABC 价格，保留同源 ABC 卖出价", async () => {
		const base = "CNY";
		const quote = "EUR";
		const at = new Date(Date.now() - 60_000);
		const legacyId = await seed(base, quote, "frankfurter", "0.625", "0.63", at);
		let sellPrice: string | undefined;
		const upstream = createRateSourceFetchStub({
			abc: () => jsonResponse({
				ErrorCode: "0",
				Data: { Table: [{
					CurrName: "欧元(EUR)", BenchMarkPrice: "160",
					PublishTime: at.toISOString(), SellPrice: sellPrice,
				}] },
			}),
		});
		const fromAbc = () =>
			new RateService(
				prisma as PrismaService,
				new RateProvider(undefined, upstream as unknown as typeof fetch),
			);

		const switched = fromAbc();
		expect(await switched.findQuoteAt(base, quote, at)).toBeNull();
		const latest = await switched.getLatest(base, [quote], true);
		expect(latest).toMatchObject({ rate: "1.6", source: "abc" });
		expect(latest).not.toHaveProperty("sellRate");
		const saved = await prisma.exchangeRate.findUniqueOrThrow({ where: { id: legacyId } });
		expect(saved).toMatchObject({ source: "abc", sellRate: null, canonicalWriteId: expect.any(String) });
		const originalTime = await switched.findQuoteAt(base, quote, at);
		expect(originalTime).toMatchObject({ rate: "1.6", source: "abc" });
		expect(originalTime).not.toHaveProperty("sellRate");

		sellPrice = "161";
		expect(await fromAbc().getLatest(base, [quote], true)).toMatchObject({ sellRate: "1.61" });
		sellPrice = undefined;
		expect(await fromAbc().getLatest(base, [quote], true)).toMatchObject({ sellRate: "1.61" });
		expect(await switched.findQuoteAt(base, quote, at)).toMatchObject({ sellRate: "1.61" });
	});
});
