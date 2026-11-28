import {
	Test,
	type TestingModule,
	type TestingModuleBuilder,
} from "@nestjs/testing";
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@prisma/client";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";
import { PrismaService } from "../../src/prisma/prisma.service";
import { TEST_PASSWORD } from "../fixtures/test-credentials";
import { listenOnTestLoopback } from "./test-http";

/**
 * 接口测试共享工具
 *
 * 约定：一个 controller 对应一个 test/{模块名}.e2e-spec.ts，
 * 建 app / 注册登录等公共逻辑只放这里，不在 spec 之间复制。
 */

export interface TestContext {
	app: INestApplication;
	prisma: PrismaService;
}

/**
 * 创建与 main.ts 配置一致的测试应用实例。
 * configure 可选钩子：在编译前对模块 builder 做额外定制（如 overrideGuard 关闭限流），
 * 不传时行为与生产完全一致。
 */
export async function createTestApp(
	configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<TestContext> {
	let builder = Test.createTestingModule({
		imports: [AppModule],
	});
	if (configure) builder = configure(builder);
	const moduleFixture: TestingModule = await builder.compile();

	const app = moduleFixture.createNestApplication();
	app.setGlobalPrefix("api");
	// 与 main.ts 生产配置一致（whitelist：漏标装饰器的字段静默剥离）
	app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
	await listenOnTestLoopback(app);

	return { app, prisma: app.get(PrismaService) };
}

export interface TestUser {
	email: string;
	password: string;
	accessToken: string;
	userId: string;
	/**
	 * 注册时兜底创建的个人默认组织（`bootstrapDefaultOrganization`）。
	 * W30（MIG-D）起业务端点一律要求显式 `X-Organization-Id`（缺头 400
	 * ORGANIZATION_REQUIRED），测试请求必须带此头——用 `orgBearer(user)`。
	 */
	defaultOrganizationId: string;
}

/** 注册并登录一个测试用户，返回 token、userId 与其默认组织 id（用后需 cleanupUser） */
export async function createTestUser(
	app: INestApplication,
	label: string,
): Promise<TestUser> {
	const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
	const password = TEST_PASSWORD;

	await request(app.getHttpServer())
		.post("/api/auth/register")
		.send({ email, password, name: label })
		.expect(201);
	const res = await request(app.getHttpServer())
		.post("/api/auth/login")
		.send({ email, password })
		.expect(200);

	const userId: string = res.body.data.user.id;
	const defaultOrganizationId = await resolveDefaultOrganizationId(
		app.get(PrismaService),
		userId,
	);
	if (!defaultOrganizationId) {
		throw new Error(
			`createTestUser(${label}): 注册后未解析到默认组织，无法构造组织上下文`,
		);
	}

	return {
		email,
		password,
		accessToken: res.body.data.accessToken,
		userId,
		defaultOrganizationId,
	};
}

/**
 * 清空某批组织的全部账本子表（ON DELETE RESTRICT 下的显式清理）。
 *
 * W30（MIG-E）：账本表已直连 `organizations`（ON DELETE RESTRICT），删组织前
 * 必须先按「子 → 父」顺序清掉全部引用行，否则外键拒绝。
 *
 * 顺序要求：
 * 1. 派生明细行（agent_proposals / usage_lot_allocations / plan_allocations /
 *    plan_change_logs / plan_installments / reminder_reads / ai_messages）先于其父行；
 * 2. 账本行（reminders / usage_records / corrections / plans / cost_lots /
 *    transactions / initial_holdings / accounts）删完后清 ledger_revisions
 *    （防删账本表触发器重新插入行），随后删 ai_conversations 与 organization_settings；
 * 3. organization_settings / organization_invitations / data_requests /
 *    audit_logs 最后（均在组织删除前清）。
 */
export async function deleteOrganizationsCascadeLedger(
	tx: Prisma.TransactionClient,
	organizationIds: readonly string[],
): Promise<void> {
	if (organizationIds.length === 0) return;
	const orgIds = [...organizationIds];

	// 1. 派生明细行（usage_lot_allocations / plan_allocations 为裸外键，先查父 ID 再删）
	const [usageRows, planRows] = await Promise.all([
		tx.usageRecord.findMany({
			where: { organizationId: { in: orgIds } },
			select: { id: true },
		}),
		tx.plan.findMany({
			where: { organizationId: { in: orgIds } },
			select: { id: true },
		}),
	]);
	const usageIds = usageRows.map((row) => row.id);
	const planIds = planRows.map((row) => row.id);
	if (usageIds.length > 0) {
		await tx.usageLotAllocation.deleteMany({
			where: { usageId: { in: usageIds } },
		});
	}
	if (planIds.length > 0) {
		await tx.planAllocation.deleteMany({
			where: { planId: { in: planIds } },
		});
	}
	await tx.planChangeLog.deleteMany({ where: { organizationId: { in: orgIds } } });
	await tx.planInstallment.deleteMany({
		where: { plan: { organizationId: { in: orgIds } } },
	});
	await tx.reminderRead.deleteMany({
		where: { reminder: { organizationId: { in: orgIds } } },
	});
	await tx.agentProposal.deleteMany({
		where: { organizationId: { in: orgIds } },
	});
	await tx.aiMessage.deleteMany({
		where: { conversation: { organizationId: { in: orgIds } } },
	});

	// 2. 账本行
	await tx.reminder.deleteMany({ where: { organizationId: { in: orgIds } } });
	await tx.usageRecord.deleteMany({ where: { organizationId: { in: orgIds } } });
	await tx.correction.deleteMany({ where: { organizationId: { in: orgIds } } });
	await tx.plan.deleteMany({ where: { organizationId: { in: orgIds } } });
	await tx.costLot.deleteMany({ where: { organizationId: { in: orgIds } } });
	await tx.transaction.deleteMany({ where: { organizationId: { in: orgIds } } });
	await tx.initialHolding.deleteMany({ where: { organizationId: { in: orgIds } } });
	await tx.account.deleteMany({ where: { organizationId: { in: orgIds } } });
	// 账本行全部删除后再清 ledger_revisions（避免删账本行触发器重新插入行）
	await tx.ledgerRevision.deleteMany({
		where: { organizationId: { in: orgIds } },
	});
	await tx.aiConversation.deleteMany({
		where: { organizationId: { in: orgIds } },
	});

	// 3. 组织附属行
	await tx.organizationSettings.deleteMany({
		where: { organizationId: { in: orgIds } },
	});
	await tx.organizationInvitation.deleteMany({
		where: { organizationId: { in: orgIds } },
	});
	await tx.dataRequest.deleteMany({
		where: { organizationId: { in: orgIds } },
	});
	// 审计日志无外键，须先于组织显式清理
	await tx.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
}

/**
 * 清理测试用户：
 * 1. 先清掉「删掉该用户后不再有任何成员」的组织及其账本子表
 *    （MIG-E 起账本表 ON DELETE RESTRICT，必须先清子表再删组织）；
 * 2. 再级联删除用户（共享组织的账本**不**随用户删除——`created_by_id` /
 *    `actor_user_id` 置 NULL，`requester_user_id` 置 NULL）。
 *
 * 仍有其他成员的共享组织保留（由用例自己的 afterAll 显式清理）。
 */
export async function cleanupUser(
	prisma: PrismaService,
	userId: string,
): Promise<void> {
	try {
		await prisma.$transaction(async (tx) => {
			// 默认组织回收：仅清掉删掉该用户后不再有任何成员的组织
			const ownMemberships = await tx.membership.findMany({
				where: { userId },
				select: { organizationId: true },
			});
			const ownOrgIds = [...new Set(ownMemberships.map((m) => m.organizationId))];
			if (ownOrgIds.length > 0) {
				const otherMembers = await tx.membership.findMany({
					where: {
						organizationId: { in: ownOrgIds },
						userId: { not: userId },
					},
					select: { organizationId: true },
				});
				const sharedOrgIds = new Set(otherMembers.map((m) => m.organizationId));
				const orphanOrgIds = ownOrgIds.filter((id) => !sharedOrgIds.has(id));
				if (orphanOrgIds.length > 0) {
					await deleteOrganizationsCascadeLedger(tx, orphanOrgIds);
					await tx.organization.deleteMany({
						where: { id: { in: orphanOrgIds } },
					});
				}
			}

			await tx.user.delete({ where: { id: userId } });
		});
	} catch {
		// 兼容已被业务流程提前删除（如账号注销用例）的用户
	}
}

/** Bearer 头快捷方式（个人域端点用：/auth/*、/organizations、/data-requests 等） */
export function bearer(token: string): { Authorization: string } {
	return { Authorization: `Bearer ${token}` };
}

/**
 * 组织域请求头快捷方式：Bearer + `X-Organization-Id`。
 *
 * W30（MIG-D）起所有组织业务端点缺组织头一律 400 ORGANIZATION_REQUIRED，
 * 测试请求必须经此函数带头（勿在各 spec 内复制）。
 */
export function orgBearer(user: TestUser): {
	Authorization: string;
	"X-Organization-Id": string;
} {
	return {
		Authorization: `Bearer ${user.accessToken}`,
		"X-Organization-Id": user.defaultOrganizationId,
	};
}

/** 组织域请求头（指定非默认组织，用于跨组织越权用例） */
export function orgBearerFor(
	user: TestUser,
	organizationId: string,
): { Authorization: string; "X-Organization-Id": string } {
	return {
		Authorization: `Bearer ${user.accessToken}`,
		"X-Organization-Id": organizationId,
	};
}

/**
 * 为任意已存在的用户签发访问令牌：直造用户（prisma.user.create）或纯 OTP 账号
 * 没有密码可走 /auth/login，组织/邀请类用例需要其登录态时经此签发。
 * 与 AuthModule 的 JwtModule 同一密钥（RequestAuthService 验签口径一致）。
 */
export function mintAccessToken(
	app: INestApplication,
	userId: string,
	email: string | null = null,
): string {
	return app.get(JwtService, { strict: false }).sign({ userId, email });
}
