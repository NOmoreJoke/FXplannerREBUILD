import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MigrationPlan } from "../../src/rate/rate-migration-plan";

interface Inventory {
	inventoryId?: string;
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
	) {
		const row = await prisma.exchangeRate.create({
			data: { base, quote, source, rate, sellRate, observedAt, createdAt },
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
		inventoryIds.push(inventory.inventoryId!);
		inventory.approvedCandidateIds = [a, b];
	});

	afterEach(async () => {
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
		const legacy = { ...inventory, inventoryId: undefined };
		check(run("rollback", legacy, false), 0, /dry-run/);
		check(run("rollback", legacy), 1, /旧清单仅可预览/);
		check(run("invert", legacy), 1, /旧清单仅可预览/);
		expect(await receipt()).toBeNull();
		expect(await snapshot()).toEqual(before);
	});

	it("数值不变的圈选只记录完成状态", async () => {
		const before = await snapshot();
		inventory.approvedCandidateIds = [noChange];
		check(run("invert", inventory), 0, /转换 0，幂等复跑已达成 1/);
		expect(await receipt()).not.toBeNull();
		check(run("rollback", inventory), 0, /转换 0，幂等复跑已达成 1/);
		expect((await receipt())?.rolledBackAt).toBeInstanceOf(Date);
		expect(await snapshot()).toEqual(before);
	});
});
