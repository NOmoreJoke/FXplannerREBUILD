/**
 * 买入交易录入接口测试（技术方案 §8.2，14 条用例）。
 * 金额断言锚定 doc 05：72,480 ÷ 7.2480 → 10,000 + 42 手续费 = 72,522 成本。
 * 时钟隔离：#11 涉「今天」判定，用 vi.useFakeTimers({ toFake: ["Date"] }) 固定时钟
 * （固定为真实当下，仅冻结流逝：JWT 不过期、防午夜 flaky）。
 */
import type { INestApplication } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../../src/audit/audit.service";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";
import { runBehindAdvisoryLock } from "../helpers/postgres-lock-barrier";
import {
	bearer,
	cleanupUser,
	createTestApp,
	createTestUser,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";
import { ensureOnboarded } from "../helpers/onboarding-helper";

// 关闭全局接口限流：AppModule 以 { provide: APP_GUARD, useClass: ThrottlerGuard } 注册全局限流，
// 但 Nest scanner 会把 APP_GUARD 的 token 改写为带 UUID 的内部 token（scanner.js insertProvider），
// overrideGuard(ThrottlerGuard) / overrideProvider(APP_GUARD) 均不命中，故直接 mock ThrottlerGuard 类
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

/** doc 05 例：72,480 元 ÷ 7.2480 = 10,000 美元，手续费 42 → 总成本 72,522 */
function doc05Body() {
	return {
		currencyCode: "USD",
		principalAmount: "72480.00",
		exchangeRate: "7.24800000",
		quantity: "10000.00",
		feeAmount: "42.00",
		transactedAt: yesterdayIso(),
	};
}

/** 填法 B：1000 ÷ 136.80 → 反算汇率 7.30994152（非整除例，fee 留空 = 未知） */
function fillBBody() {
	return {
		currencyCode: "USD",
		principalAmount: "1000.00",
		exchangeRate: "7.30994152",
		quantity: "136.80",
		transactedAt: yesterdayIso(),
	};
}

/** 汇率 1 的简化体（金额 = 数量，便于余额累加断言） */
function simpleBody(currencyCode: string, quantity: string) {
	return {
		currencyCode,
		principalAmount: quantity,
		exchangeRate: "1",
		quantity,
		transactedAt: yesterdayIso(),
	};
}

/** 昨天时刻：UTC+8 口径必不晚于今天，免依赖真实时钟 */
function yesterdayIso(): string {
	return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

describe("TransactionController（接口）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let userA: TestUser;
	let userB: TestUser;
	let userC: TestUser;
	let txIdA = ""; // #2 填法 A 创建的交易（userA）
	let txIdB = ""; // #3 填法 B 创建的交易（userB）
	const userIds: string[] = [];

	function postTx(user: TestUser, body: Record<string, unknown>) {
		return request(app.getHttpServer())
			.post("/api/transactions")
			.set(bearer(user.accessToken))
			.send(body);
	}

	function getTx(user: TestUser, id: string) {
		return request(app.getHttpServer())
			.get(`/api/transactions/${id}`)
			.set(bearer(user.accessToken));
	}

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		userA = await createTestUser(app, "tx-a");
		userB = await createTestUser(app, "tx-b");
		userC = await createTestUser(app, "tx-c");
		userIds.push(userA.userId, userB.userId, userC.userId);
		// BE-03：录交易需已建账，否则写入口 409 ONBOARDING_NOT_COMPLETED
		for (const user of [userA, userB, userC]) {
			await ensureOnboarded(ctx.prisma, user.userId);
		}
	});

	afterAll(async () => {
		for (const userId of userIds) {
			await cleanupUser(ctx.prisma, userId);
		}
		await app.close();
	});

	it("#1 未登录访问两接口均 401", async () => {
		await request(app.getHttpServer())
			.post("/api/transactions")
			.send(doc05Body())
			.expect(401);
		await request(app.getHttpServer())
			.get("/api/transactions/nonexistent")
			.expect(401);
	});

	it("#2 填法 A 创建（含手续费 42，锚定 doc 05）：201，totalCost=72522", async () => {
		const res = await postTx(userA, doc05Body()).expect(201);
		expect(res.body.success).toBe(true);
		expect(res.body.data).toMatchObject({
			currencyCode: "USD",
			quantity: "10000.0000",
			principalAmount: "72480.0000",
			feeAmount: "42.0000",
			totalCost: "72522.0000", // 72,480 + 42
			feeKnown: true,
			exchangeRate: "7.24800000",
			planId: null,
			planName: null,
			version: 1,
		});
		txIdA = res.body.data.id as string;
	});

	it("#3 填法 B 创建（fee 留空，非整除例 1000÷7.31）：201，fee 未知不被误杀", async () => {
		const res = await postTx(userB, fillBBody()).expect(201);
		expect(res.body.data).toMatchObject({
			quantity: "136.8000",
			principalAmount: "1000.0000",
			feeAmount: null,
			totalCost: null, // 手续费未知时成本不完整，绝不当 0 计算
			feeKnown: false,
			exchangeRate: "7.30994152",
		});
		txIdB = res.body.data.id as string;
	});

	it('#4 feeAmount="0"：落库 0（无手续费），区别于 null（未知）', async () => {
		const res = await postTx(userA, {
			...simpleBody("GBP", "500"),
			feeAmount: "0",
		}).expect(201);
		expect(res.body.data.feeAmount).toBe("0.0000");
		expect(res.body.data.feeKnown).toBe(true);
		expect(res.body.data.totalCost).toBe("500.0000"); // 本金 + 0

		const saved = await ctx.prisma.transaction.findUnique({
			where: { id: res.body.data.id },
		});
		expect(saved?.feeAmount?.toFixed(4)).toBe("0.0000");
	});

	it("#5 首次买入自动建户：Account 创建且 balance=quantity（不变式：0 分配 + 未分配）", async () => {
		// #2 是 userA 的首笔 USD 买入；M4 无分配 → Σ计划剩余分配 = 0，
		// 不变式「balance = Σ剩余分配 + 未分配余额」简化为 balance = quantity
		const accounts = await ctx.prisma.account.findMany({
			where: { userId: userA.userId, currencyCode: "USD" },
		});
		expect(accounts).toHaveLength(1);
		expect(accounts[0].balance.toFixed(4)).toBe("10000.0000");
	});

	it("#6 同币种第二笔买入：不新建户，余额原子累加，不变式保持", async () => {
		await postTx(userA, simpleBody("USD", "250.25")).expect(201);

		const accounts = await ctx.prisma.account.findMany({
			where: { userId: userA.userId, currencyCode: "USD" },
		});
		expect(accounts).toHaveLength(1); // 不新建户
		expect(accounts[0].balance.toFixed(4)).toBe("10250.2500"); // 10000 + 250.25
	});

	it("#7 并发：两请求同时首购同币种，均 201、账户仅一行、balance=两笔之和", async () => {
		const [r1, r2] = await Promise.all([
			postTx(userC, simpleBody("EUR", "100.00")),
			postTx(userC, simpleBody("EUR", "200.00")),
		]);
		expect(r1.status).toBe(201);
		expect(r2.status).toBe(201);

		const accounts = await ctx.prisma.account.findMany({
			where: { userId: userC.userId, currencyCode: "EUR" },
		});
		expect(accounts).toHaveLength(1); // increment 原子性 + P2002 降级生效
		expect(accounts[0].balance.toFixed(4)).toBe("300.0000");
	});

	it("#8 三值不自洽（仅改 quantity，两方向均不满足）：400，账户无变化", async () => {
		const res = await postTx(userA, {
			...doc05Body(),
			quantity: "999.99",
		}).expect(400);
		expect(res.body.code).toBe("INVALID_TRANSACTION_PARAMS");
		expect(res.body.message).toContain("重新核对");

		const accounts = await ctx.prisma.account.findMany({
			where: { userId: userA.userId, currencyCode: "USD" },
		});
		expect(accounts[0].balance.toFixed(4)).toBe("10250.2500"); // 未被污染
	});

	it("#9 到账金额正数舍 0（极小本金×低汇率）：400 ROUND_TO_ZERO", async () => {
		const res = await postTx(userA, {
			...simpleBody("USD", "0.01"),
			principalAmount: "0.001",
			exchangeRate: "2", // 0.001 ÷ 2 = 0.0005 → 2 位精度舍为 0
		}).expect(400);
		expect(res.body.code).toBe("ROUND_TO_ZERO");
	});

	it("#10 关联计划：正常/他人/币种不匹配/不存在 → 201/404/400/404，计划零改动", async () => {
		const future = new Date("2027-01-01T00:00:00.000Z");
		const planJpy = await ctx.prisma.plan.create({
			data: {
				userId: userA.userId,
				name: "日元学费计划",
				targetCurrency: "JPY",
				targetAmount: "1000000",
				expectUseDate: future,
				latestPrepDate: future,
			},
		});
		const planOfB = await ctx.prisma.plan.create({
			data: {
				userId: userB.userId,
				name: "他人计划",
				targetCurrency: "USD",
				targetAmount: "1000",
				expectUseDate: future,
				latestPrepDate: future,
			},
		});
		const beforeJpy = await ctx.prisma.plan.findUnique({
			where: { id: planJpy.id },
		});
		const beforeB = await ctx.prisma.plan.findUnique({
			where: { id: planOfB.id },
		});

		// 正常：本人 JPY 计划 + 买入 JPY → 201，回显计划名
		const ok = await postTx(userA, {
			...simpleBody("JPY", "1000"),
			principalAmount: "152000",
			exchangeRate: "152",
			planId: planJpy.id,
		}).expect(201);
		expect(ok.body.data.planId).toBe(planJpy.id);
		expect(ok.body.data.planName).toBe("日元学费计划");

		// 他人计划：userA 提交 userB 的计划 → 404（不泄露存在性）
		const foreign = await postTx(userA, {
			...simpleBody("USD", "100"),
			planId: planOfB.id,
		}).expect(404);
		expect(foreign.body.code).toBe("PLAN_NOT_FOUND");

		// 币种不匹配：JPY 计划 + 买入 USD → 400
		const mismatch = await postTx(userA, {
			...simpleBody("USD", "100"),
			planId: planJpy.id,
		}).expect(400);
		expect(mismatch.body.code).toBe("PLAN_CURRENCY_MISMATCH");

		// 不存在：planId 查无此行 → 404
		const ghost = await postTx(userA, {
			...simpleBody("USD", "100"),
			planId: "tx-nonexistent-plan",
		}).expect(404);
		expect(ghost.body.code).toBe("PLAN_NOT_FOUND");

		// 计划数据零改动（仅标记，不触发分配）
		const afterJpy = await ctx.prisma.plan.findUnique({
			where: { id: planJpy.id },
		});
		const afterB = await ctx.prisma.plan.findUnique({
			where: { id: planOfB.id },
		});
		expect(afterJpy?.updatedAt.getTime()).toBe(beforeJpy?.updatedAt.getTime());
		expect(afterJpy?.status).toBe(beforeJpy?.status);
		expect(afterB?.updatedAt.getTime()).toBe(beforeB?.updatedAt.getTime());
	});

	it("#11 日期晚于今天（固定时钟）/ 早于账本起点：400 且 message 可区分", async () => {
		// 固定为真实当下并冻结流逝：JWT 不过期、无午夜/跨秒 flaky
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
		try {
			// +48h 在 UTC+8 日界上必属「明天」→ 晚于今天
			const late = await postTx(userA, {
				...simpleBody("GBP", "100"),
				transactedAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
			}).expect(400);
			expect(late.body.code).toBe("INVALID_TRANSACTION_PARAMS");
			expect(late.body.message).toContain("晚于今天");

			// 设置账本起点为 10 天前（同步更新 UserSettings 与默认组织 OrganizationSettings）
			const ledgerStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
			await ensureOnboarded(ctx.prisma, userA.userId, "CNY", ledgerStart);

			// 早于账本起点 → 400，message 与上界失败可区分
			const early = await postTx(userA, {
				...simpleBody("GBP", "100"),
				transactedAt: new Date(
					Date.now() - 20 * 24 * 60 * 60 * 1000,
				).toISOString(),
			}).expect(400);
			expect(early.body.code).toBe("INVALID_TRANSACTION_PARAMS");
			expect(early.body.message).toContain("账本起点");
			expect(early.body.message).not.toBe(late.body.message);

			// 边界含：恰为账本起点 → 201
			const ok = await postTx(userA, {
				...simpleBody("GBP", "100"),
				transactedAt: ledgerStart.toISOString(),
			}).expect(201);
			expect(ok.body.data.transactedAt).toBe(ledgerStart.toISOString());
		} finally {
			vi.useRealTimers();
		}
	});

	it("#11b 无效日期：DTO 放行的松散写法 → 400，而非 500（评审 R3-I06 同类面）", async () => {
		// DTO 的 @IsISO8601 未开 strict，会放行周年 / 基本格式写法；new Date() 得
		// Invalid Date，而日期范围校验对 NaN 的比较恒为假——此前无效值一路带到
		// Prisma 抛校验错误（HTTP 500）。与 usage.parseUsedAt 同口径在服务层拦截
		for (const transactedAt of ["2026-W01-1", "20261123", "20261123T000000Z"]) {
			const res = await postTx(userA, {
				...simpleBody("GBP", "100"),
				transactedAt,
			}).expect(400);
			expect(res.body.code, transactedAt).toBe("INVALID_TRANSACTION_PARAMS");
			expect(res.body.message, transactedAt).toContain("有效的 ISO 8601");
		}
	});

	it("#12 JPY 传入 2 位小数 quantity：400（超币种精度，JPY 必须整数）", async () => {
		const res = await postTx(userA, {
			currencyCode: "JPY",
			principalAmount: "10192.00",
			exchangeRate: "152.12345678",
			quantity: "66.66",
			transactedAt: yesterdayIso(),
		}).expect(400);
		expect(res.body.code).toBe("INVALID_TRANSACTION_PARAMS");
		expect(res.body.message).toContain("整数");
	});

	it("#13 汇总参数校验：非法入参均 400；DTO 拒绝 JSON number", async () => {
		// DTO 层拒绝（ValidationPipe 格式：{ statusCode, message[], error }，无模块 code）
		for (const body of [
			{ ...doc05Body(), currencyCode: "XYZ" }, // 非 15 币种
			{ ...doc05Body(), exchangeRate: "7.123456789" }, // 汇率超 8 位小数
			{ ...doc05Body(), principalAmount: 72480 }, // JSON number（@IsString 拒绝）
		]) {
			const res = await postTx(userA, body).expect(400);
			expect(res.body.error).toBe("Bad Request");
			expect(res.body.statusCode).toBe(400);
			expect(res.body.code).toBeUndefined();
		}

		// service 层拒绝（{ code, message } 格式）
		for (const body of [
			{ ...doc05Body(), principalAmount: "0" }, // ≤ 0
			{ ...doc05Body(), principalAmount: "100000000000" }, // ≥ 1e11 上限（开区间）
			{ ...doc05Body(), feeAmount: "-5" }, // 手续费负数
			{ ...doc05Body(), principalAmount: "abc" }, // 金额非数字字符串
		]) {
			const res = await postTx(userA, body).expect(400);
			expect(res.body.code).toBe("INVALID_TRANSACTION_PARAMS");
		}
	});

	it("#14 详情：本人可见 200 / 他人记录 404", async () => {
		const own = await getTx(userB, txIdB).expect(200);
		expect(own.body.success).toBe(true);
		expect(own.body.data.id).toBe(txIdB);
		expect(own.body.data.feeAmount).toBeNull(); // #3 的记录：费用未明确

		const other = await getTx(userB, txIdA).expect(404);
		expect(other.body.code).toBe("TRANSACTION_NOT_FOUND");
	});

	// ── 以下为 account-module 第④步（成本批次同步补写，方案 §3.4/§8.2 追加）──

	it("#15 录入成功后 CostLot 行存在：remainingQty/unitCost/totalCost/acquiredAt 与 §3.4 一致", async () => {
		// txIdA 为 #2 的 doc 05 录入（本金 72480 + 手续费 42 ÷ 数量 10000）
		const lot = await ctx.prisma.costLot.findFirst({
			where: { userId: userA.userId, sourceType: "PURCHASE", sourceId: txIdA },
		});
		expect(lot).not.toBeNull();
		expect(lot?.currencyCode).toBe("USD");
		expect(lot?.quantity.toFixed(4)).toBe("10000.0000");
		expect(lot?.remainingQty.toFixed(4)).toBe("10000.0000"); // 新批次未消耗
		expect(lot?.totalCost.toFixed(4)).toBe("72522.0000"); // 72480 + 42
		expect(lot?.unitCost.toFixed(8)).toBe("7.25220000"); // 72522 ÷ 10000
		// acquiredAt = transactedAt（同日顺序由 createdAt 保留，doc 09）
		const txRow = await ctx.prisma.transaction.findUnique({
			where: { id: txIdA },
		});
		expect(txRow).not.toBeNull();
		expect(lot?.acquiredAt.getTime()).toBe(txRow!.transactedAt.getTime());
	});

	it("#16 组合级不变式：USD 账户 Σ costLot.remainingQty === balance（10000 + 250.25）", async () => {
		// 前序用例累计：#2 doc 05（10000）+ #6（250.25）= 10250.25
		const account = await ctx.prisma.account.findFirst({
			where: { userId: userA.userId, currencyCode: "USD" },
		});
		expect(account?.balance.toFixed(4)).toBe("10250.2500");

		const lots = await ctx.prisma.costLot.findMany({
			where: {
				userId: userA.userId,
				currencyCode: "USD",
				sourceType: "PURCHASE",
			},
		});
		expect(lots).toHaveLength(2); // 两笔买入各一批次
		const sumRemainingQty = lots.reduce(
			(acc, lot) => acc.add(lot.remainingQty),
			new Prisma.Decimal(0),
		);
		expect(sumRemainingQty.toFixed(4)).toBe(account!.balance.toFixed(4));
	});

	it("#17 事务内失败注入回滚：PLAN_NOT_FOUND 后 CAD 账户/交易/批次零残留", async () => {
		// 注：ROUND_TO_ZERO 发生在事务外 parseParams 阶段（#9 已覆盖），不适用于
		// 验证含第④步的事务回滚；此处用事务内①步骤（plan 校验）失败验证整体回滚。
		const res = await postTx(userA, {
			...simpleBody("CAD", "100"),
			planId: "tx-nonexistent-plan",
		}).expect(404);
		expect(res.body.code).toBe("PLAN_NOT_FOUND");

		// 含第④步的整体回滚：账户、交易、批次三表均无 CAD 残留
		expect(
			await ctx.prisma.account.count({
				where: { userId: userA.userId, currencyCode: "CAD" },
			}),
		).toBe(0);
		expect(
			await ctx.prisma.transaction.count({
				where: { userId: userA.userId, currencyCode: "CAD" },
			}),
		).toBe(0);
		expect(
			await ctx.prisma.costLot.count({
				where: { userId: userA.userId, currencyCode: "CAD" },
			}),
		).toBe(0);
	});
});

describe("ToB R1 W23：Transaction 写接口 Actor 化 + 权限矩阵 + 跨组织隔离 + 锁内降权 + 审计回滚（支持 -t 独立运行）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const scopedUserIds: string[] = [];
	const scopedPlanIds: string[] = [];

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (scopedPlanIds.length > 0) {
			await ctx.prisma.planAllocation.deleteMany({
				where: { planId: { in: scopedPlanIds.splice(0) } },
			});
		}
		while (scopedUserIds.length > 0) {
			const uid = scopedUserIds.pop()!;
			await cleanupUser(ctx.prisma, uid);
		}
	});

	afterAll(async () => {
		await app?.close();
	});

	async function setupOrgWithMember(
		label: string,
		role: "OWNER" | "ADMIN" | "FINANCE" | "OPERATOR" | "VIEWER",
	) {
		const owner = await createTestUser(app, `tx-w23-owner-${label}`);
		scopedUserIds.push(owner.userId);
		await ensureOnboarded(ctx.prisma, owner.userId);
		const orgId = (await resolveDefaultOrganizationId(ctx.prisma, owner.userId))!;
		const member = await createTestUser(app, `tx-w23-mem-${label}`);
		scopedUserIds.push(member.userId);
		await ctx.prisma.membership.create({
			data: {
				organizationId: orgId,
				userId: member.userId,
				role,
				status: "ACTIVE",
			},
		});
		return { owner, member, orgId };
	}

	it.each(["OPERATOR", "VIEWER"] as const)(
		"W23-TX-1 %s 调用 POST /api/transactions → 403 PERMISSION_DENIED + DENIED 审计 + 零账本写入",
		async (role) => {
			const { member, orgId } = await setupOrgWithMember(role.toLowerCase(), role);
			const reqId = `req-tx-denied-${role}-${Date.now()}`;

			const res = await request(app.getHttpServer())
				.post("/api/transactions")
				.set(bearer(member.accessToken))
				.set("X-Organization-Id", orgId)
				.set("X-Request-Id", reqId)
				.send(simpleBody("USD", "100.00"))
				.expect(403);
			expect(res.body.code).toBe("PERMISSION_DENIED");

			expect(
				await ctx.prisma.transaction.count({ where: { organizationId: orgId } }),
			).toBe(0);
			expect(
				await ctx.prisma.costLot.count({ where: { organizationId: orgId } }),
			).toBe(0);
			expect(
				await ctx.prisma.account.count({ where: { organizationId: orgId } }),
			).toBe(0);

			const deniedAudit = await ctx.prisma.auditLog.findFirst({
				where: {
					organizationId: orgId,
					actorUserId: member.userId,
					action: "permission.denied.transaction.create",
					result: "DENIED",
					requestId: reqId,
				},
			});
			expect(deniedAudit).not.toBeNull();
		},
	);

	it("W23-TX-2 多成员共享账本：Owner 与 Finance 同币种买入共写同一组织 Account + CostLot + 同事务 AuditLog", async () => {
		const { owner, member: finance, orgId } = await setupOrgWithMember(
			"shared",
			"FINANCE",
		);
		const req1 = `req-tx-owner-${Date.now()}`;
		const req2 = `req-tx-fin-${Date.now()}`;

		const res1 = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(bearer(owner.accessToken))
			.set("X-Organization-Id", orgId)
			.set("X-Request-Id", req1)
			.send(simpleBody("USD", "300.00"))
			.expect(201);

		const res2 = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(bearer(finance.accessToken))
			.set("X-Organization-Id", orgId)
			.set("X-Request-Id", req2)
			.send(simpleBody("USD", "200.50"))
			.expect(201);

		const accounts = await ctx.prisma.account.findMany({
			where: { organizationId: orgId, currencyCode: "USD" },
		});
		expect(accounts).toHaveLength(1);
		expect(accounts[0].balance.toFixed(4)).toBe("500.5000");

		const txRows = await ctx.prisma.transaction.findMany({
			where: { organizationId: orgId },
			orderBy: { createdAt: "asc" },
		});
		expect(txRows).toHaveLength(2);
		expect(txRows.map((t) => t.createdById)).toEqual([
			owner.userId,
			finance.userId,
		]);

		const lots = await ctx.prisma.costLot.findMany({
			where: { organizationId: orgId, currencyCode: "USD" },
		});
		expect(lots).toHaveLength(2);
		expect(lots.every((l) => l.organizationId === orgId)).toBe(true);

		const audits = await ctx.prisma.auditLog.findMany({
			where: {
				organizationId: orgId,
				action: "transaction.create",
				result: "SUCCESS",
			},
		});
		expect(audits.map((a) => a.targetId).sort()).toEqual(
			[res1.body.data.id, res2.body.data.id].sort(),
		);
		expect(audits.map((a) => a.requestId).sort()).toEqual([req1, req2].sort());
	});

	it("W23-TX-3 跨组织 planId 隔离：多组织用户在 Org B 关联 Org A 计划 → 404 PLAN_NOT_FOUND", async () => {
		const user = await createTestUser(app, "tx-w23-cross-org");
		scopedUserIds.push(user.userId);
		await ensureOnboarded(ctx.prisma, user.userId);
		const orgAId = (await resolveDefaultOrganizationId(ctx.prisma, user.userId))!;

		const orgBRes = await request(app.getHttpServer())
			.post("/api/organizations")
			.set(bearer(user.accessToken))
			.send({ name: "TX 跨组织测试 B" })
			.expect(201);
		const orgBId = orgBRes.body.data.id as string;
		await ctx.prisma.organizationSettings.create({
			data: {
				organizationId: orgBId,
				baseCurrency: "CNY",
				prepPreference: "balanced",
				reminderEnabled: true,
			},
		});

		const future = new Date("2030-02-15T00:00:00.000Z");
		const planInA = await ctx.prisma.plan.create({
			data: {
				userId: user.userId,
				organizationId: orgAId,
				createdById: user.userId,
				name: "Org A 专属计划",
				targetCurrency: "USD",
				targetAmount: "5000",
				expectUseDate: future,
				latestPrepDate: future,
			},
		});
		scopedPlanIds.push(planInA.id);

		const cross = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(bearer(user.accessToken))
			.set("X-Organization-Id", orgBId)
			.send({ ...simpleBody("USD", "100.00"), planId: planInA.id })
			.expect(404);
		expect(cross.body.code).toBe("PLAN_NOT_FOUND");
		expect(
			await ctx.prisma.transaction.count({ where: { organizationId: orgBId } }),
		).toBe(0);
	});

	it("W23-TX-4 锁等期间降权（FINANCE → OPERATOR）：事务内复验失败 → 403 + DENIED 审计 + 零写入", async () => {
		const { member: finance, orgId } = await setupOrgWithMember(
			"demote",
			"FINANCE",
		);
		const reqId = `req-tx-demote-${Date.now()}`;

		const res = await runBehindAdvisoryLock(
			ctx.prisma,
			`membership:${orgId}`,
			() =>
				request(app.getHttpServer())
					.post("/api/transactions")
					.set(bearer(finance.accessToken))
					.set("X-Organization-Id", orgId)
					.set("X-Request-Id", reqId)
					.send(simpleBody("USD", "250.00")),
			async () => {
				await ctx.prisma.membership.update({
					where: {
						organizationId_userId: {
							organizationId: orgId,
							userId: finance.userId,
						},
					},
					data: { role: "OPERATOR" },
				});
			},
		);

		expect(res.status).toBe(403);
		expect(res.body.code).toBe("PERMISSION_DENIED");
		expect(
			await ctx.prisma.transaction.count({ where: { organizationId: orgId } }),
		).toBe(0);
		expect(
			await ctx.prisma.costLot.count({ where: { organizationId: orgId } }),
		).toBe(0);
		expect(
			await ctx.prisma.account.count({ where: { organizationId: orgId } }),
		).toBe(0);
		const denied = await ctx.prisma.auditLog.findFirst({
			where: {
				organizationId: orgId,
				actorUserId: finance.userId,
				action: "permission.denied.transaction.create",
				result: "DENIED",
				requestId: reqId,
			},
		});
		expect(denied).not.toBeNull();
	});

	it("W23-TX-5 AuditService.recordInTx 故障注入：Transaction / CostLot / Account 整单回滚", async () => {
		const { member: finance, orgId } = await setupOrgWithMember(
			"audit-fault",
			"FINANCE",
		);

		vi.spyOn(app.get(AuditService), "recordInTx").mockRejectedValueOnce(
			new Error("injected tx audit failure"),
		);

		await request(app.getHttpServer())
			.post("/api/transactions")
			.set(bearer(finance.accessToken))
			.set("X-Organization-Id", orgId)
			.send(simpleBody("EUR", "500.00"))
			.expect(500);

		expect(
			await ctx.prisma.transaction.count({ where: { organizationId: orgId } }),
		).toBe(0);
		expect(
			await ctx.prisma.costLot.count({ where: { organizationId: orgId } }),
		).toBe(0);
		expect(
			await ctx.prisma.account.count({ where: { organizationId: orgId } }),
		).toBe(0);
	});

	it("I-2 双账户行防护：受邀 FINANCE 买入合并 Owner 遗留 NULL 账户与既有组织账户（零 P2002 且双方余额一致）", async () => {
		const { owner, member: finance, orgId } = await setupOrgWithMember(
			"i2-dual-merge",
			"FINANCE",
		);
		// 构造双行异常前置态：既有组织行(20) + Owner legacy NULL 行(50)
		await ctx.prisma.account.create({
			data: {
				userId: owner.userId,
				organizationId: orgId,
				createdById: owner.userId,
				currencyCode: "USD",
				balance: "20.0000",
			},
		});
		await ctx.prisma.account.create({
			data: {
				userId: owner.userId,
				organizationId: null,
				currencyCode: "USD",
				balance: "50.0000",
			},
		});

		await request(app.getHttpServer())
			.post("/api/transactions")
			.set(bearer(finance.accessToken))
			.set("X-Organization-Id", orgId)
			.send(simpleBody("USD", "30.00"))
			.expect(201);

		const orgAccounts = await ctx.prisma.account.findMany({
			where: { organizationId: orgId, currencyCode: "USD" },
		});
		expect(orgAccounts).toHaveLength(1);
		expect(orgAccounts[0].balance.toFixed(4)).toBe("100.0000");
		expect(
			await ctx.prisma.account.count({
				where: { userId: owner.userId, organizationId: null, currencyCode: "USD" },
			}),
		).toBe(0);

		const [ownerAccounts, financeAccounts] = await Promise.all([
			request(app.getHttpServer())
				.get("/api/accounts/USD")
				.set(bearer(owner.accessToken))
				.set("X-Organization-Id", orgId)
				.expect(200),
			request(app.getHttpServer())
				.get("/api/accounts/USD")
				.set(bearer(finance.accessToken))
				.set("X-Organization-Id", orgId)
				.expect(200),
		]);
		expect(ownerAccounts.body.data.balance).toBe("100.0000");
		expect(financeAccounts.body.data.balance).toBe("100.0000");
	});
});
