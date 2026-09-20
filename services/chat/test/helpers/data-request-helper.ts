import type { INestApplication } from "@nestjs/common";
import { expect } from "vitest";
import request from "supertest";
import { OTP_CHANNELS, OTP_OPTIONS } from "../../src/auth/otp/otp-channel";
import {
	createCapturingEmailOtpChannel,
	type CapturingEmailOtpChannel,
} from "./capturing-email-otp-channel";
import {
	createTestApp,
	type TestContext,
	type TestUser,
} from "./test-app";
import type { PrismaService } from "../../src/prisma/prisma.service";

/**
 * 数据请求测试共享工具（account-data 技术方案 §10）。
 *
 * 组合：捕获验证码 fake 渠道 + 放开 OTP 频控（全局限流由 spec 文件 vi.mock 关闭，
 * 先例 plan-usage.spec——APP_GUARD token 无法 override，只能 mock 类）；
 * 造数直接写库（不走 API 校验路径），涉及到期推进的场景用直接写库
 * dueAt/consumedAt 过去时刻构造，不等待真实时间。
 */

export interface DataRequestTestEnv {
	ctx: TestContext;
	app: INestApplication;
	prisma: PrismaService;
	otpChannel: CapturingEmailOtpChannel;
}

export async function createDataRequestTestApp(): Promise<DataRequestTestEnv> {
	const otpChannel = createCapturingEmailOtpChannel();
	const ctx = await createTestApp((builder) =>
		builder
			.overrideProvider(OTP_CHANNELS)
			.useValue([otpChannel])
			.overrideProvider(OTP_OPTIONS)
			.useValue({
				targetMaxRequests: 100,
				ipMaxRequests: 100,
				// 测试集中发码：同步放开 1h/24h 发送上限（频控语义由 otp.spec 覆盖）
				sendMaxPerHour: 1000,
				sendMaxPerDay: 1000,
			}),
	);
	return {
		ctx,
		app: ctx.app,
		prisma: ctx.prisma,
		otpChannel,
	};
}

/** 完成首次设置（consents + complete），返回 settings 行 */
export async function completeOnboarding(
	app: INestApplication,
	token: string,
	baseCurrency = "CNY",
): Promise<void> {
	await request(app.getHttpServer())
		.post("/api/onboarding/consents")
		.set("Authorization", `Bearer ${token}`)
		.send({ age18Confirmed: true, termsConfirmed: true })
		.expect(201);
	await request(app.getHttpServer())
		.post("/api/onboarding/complete")
		.set("Authorization", `Bearer ${token}`)
		.send({
			baseCurrency,
			locale: "zh-CN",
			region: "CN",
			prepPreference: "balanced",
			reminderEnabled: true,
		})
		.expect(201);
}

/** 发送对应用途验证码并完成 verify（返回确认凭证与截止时刻） */
export async function sendAndVerify(
	app: INestApplication,
	otpChannel: CapturingEmailOtpChannel,
	token: string,
	target: string,
	purpose: "EXPORT" | "CLEAR" | "DELETION",
): Promise<{ challengeId: string; confirmDeadline: string }> {
	const sent = await request(app.getHttpServer())
		.post("/api/auth/otp/send-code")
		.set("Authorization", `Bearer ${token}`)
		.send({ channel: "email", target, purpose })
		.expect(200);
	const code = otpChannel.lastCode();
	expect(code).toBeDefined();
	const verified = await request(app.getHttpServer())
		.post("/api/data-requests/verify")
		.set("Authorization", `Bearer ${token}`)
		.send({ challengeId: sent.body.data.challengeId, code, purpose })
		.expect(200);
	return {
		challengeId: verified.body.data.challengeId,
		confirmDeadline: verified.body.data.confirmDeadline,
	};
}

/** 直接置 consumedAt 模拟已消费凭证（绕过 verify，精确控制确认窗口时间） */
export async function consumeChallenge(
	prisma: PrismaService,
	challengeId: string,
	consumedAt: Date,
): Promise<void> {
	await prisma.otpChallenge.update({
		where: { id: challengeId },
		data: { consumedAt },
	});
}

/** 直接将请求 dueAt 置为过去（构造「到期推进」场景，不等待真实时间） */
export async function makeRequestDue(
	prisma: PrismaService,
	requestId: string,
	dueAt: Date,
): Promise<void> {
	await prisma.dataRequest.update({
		where: { id: requestId },
		data: { dueAt },
	});
}

export interface SeedBusinessDataResult {
	accountId: string;
	transactionId: string;
	planId: string;
	planAllocationId: string;
	usageRecordId: string;
	usageLotAllocationId: string;
	costLotId: string;
	correctionId: string;
	reminderId: string;
}

/**
 * 种一套完整业务数据（集成测试生命周期用）：
 * 初始持仓 + 买入（未知手续费）+ 计划 + 分配 + 使用 + 成本批次 + 分摊 + 更正 + 提醒。
 * 直接写库，跳过 API 校验（数据可控、可复算）。
 */
export async function seedBusinessData(
	prisma: PrismaService,
	userId: string,
): Promise<SeedBusinessDataResult> {
	const now = new Date();
	const account = await prisma.account.create({
		data: { userId, currencyCode: "USD", balance: "900.0000" },
	});
	const holding = await prisma.initialHolding.create({
		data: {
			userId,
			currencyCode: "CAD",
			amount: "100.0000",
			rate: "5.0000000000",
			rawRate: "5.00000000",
			rateSource: "abc",
			rateObservedAt: now,
			cost: "500.0000",
			confirmedAt: now,
		},
	});
	const transaction = await prisma.transaction.create({
		data: {
			userId,
			currencyCode: "USD",
			quantity: "100.0000",
			principalAmount: "720.0000",
			feeAmount: null, // 未知手续费（导出「未知」断言依赖）
			exchangeRate: "7.2000000000",
			rateSource: "abc",
			rateObservedAt: now,
			transactedAt: now,
		},
	});
	const costLot = await prisma.costLot.create({
		data: {
			userId,
			currencyCode: "USD",
			sourceType: "PURCHASE",
			sourceId: transaction.id,
			quantity: "100.0000",
			remainingQty: "60.0000",
			unitCost: "7.2000000000",
			totalCost: "720.0000",
			acquiredAt: now,
		},
	});
	const plan = await prisma.plan.create({
		data: {
			userId,
			name: "测试计划",
			targetCurrency: "USD",
			targetAmount: "1000.0000",
			expectUseDate: new Date(now.getTime() + 30 * 86400000),
			prepLeadDays: 3,
			latestPrepDate: now,
			status: "ACTIVE",
		},
	});
	const allocation = await prisma.planAllocation.create({
		data: { planId: plan.id, amount: "600.0000", usedAmount: "288.0000" },
	});
	const usage = await prisma.usageRecord.create({
		data: {
			userId,
			planId: plan.id,
			currencyCode: "USD",
			amount: "40.0000",
			usedAt: now,
		},
	});
	const usageLot = await prisma.usageLotAllocation.create({
		data: {
			usageId: usage.id,
			lotId: costLot.id,
			quantity: "40.0000",
			cost: "288.0000",
		},
	});
	const correction = await prisma.correction.create({
		data: {
			userId,
			targetType: "TRANSACTION",
			targetId: transaction.id,
			reason: "手续费补录",
			beforeSnapshot: { feeAmount: null },
			afterSnapshot: { feeAmount: "10" },
			status: "APPLIED",
		},
	});
	const reminder = await prisma.reminder.create({
		data: {
			userId,
			type: "PREP",
			planId: plan.id,
			dedupKey: `PREP:${plan.id}`,
			scheduledFor: now,
		},
	});
	void holding;
	return {
		accountId: account.id,
		transactionId: transaction.id,
		planId: plan.id,
		planAllocationId: allocation.id,
		usageRecordId: usage.id,
		usageLotAllocationId: usageLot.id,
		costLotId: costLot.id,
		correctionId: correction.id,
		reminderId: reminder.id,
	};
}

export type { TestUser };
