import {
	Test,
	type TestingModule,
	type TestingModuleBuilder,
} from "@nestjs/testing";
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import { AppModule } from "../../src/app.module";
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
}

/** 注册并登录一个测试用户，返回 token 与 userId（用后需 cleanupUser） */
export async function createTestUser(
	app: INestApplication,
	label: string,
): Promise<TestUser> {
	const email = `${label}-${Date.now()}@example.com`;
	const password = TEST_PASSWORD;

	await request(app.getHttpServer())
		.post("/api/auth/register")
		.send({ email, password, name: label })
		.expect(201);

	const res = await request(app.getHttpServer())
		.post("/api/auth/login")
		.send({ email, password })
		.expect(200);

	return {
		email,
		password,
		accessToken: res.body.data.accessToken,
		userId: res.body.data.user.id,
	};
}

/**
 * 清理测试用户：先清理裸外键关联的 PlanAllocation / UsageLotAllocation 防遗留孤儿行，
 * 再回收「删掉该用户后不再有任何成员」的组织（注册/验证码首登兜底的默认组织及其
 * 审计日志——组织本身不随 User 级联，只有 Membership 级联；评审 I-17 实测本地库
 * 累积 1905 条无成员孤儿 organizations），最后级联删除用户。
 * 仍有其他成员的共享组织保留（由用例自己的 afterAll 显式清理）。
 */
export async function cleanupUser(
	prisma: PrismaService,
	userId: string,
): Promise<void> {
	try {
		await prisma.$transaction(async (tx) => {
			const [plans, usages, lots] = await Promise.all([
				tx.plan.findMany({ where: { userId }, select: { id: true } }),
				tx.usageRecord.findMany({ where: { userId }, select: { id: true } }),
				tx.costLot.findMany({ where: { userId }, select: { id: true } }),
			]);
			const planIds = plans.map((p) => p.id);
			const usageIds = usages.map((u) => u.id);
			const lotIds = lots.map((l) => l.id);

			if (usageIds.length > 0 || lotIds.length > 0) {
				await tx.usageLotAllocation.deleteMany({
					where: {
						OR: [
							...(usageIds.length > 0 ? [{ usageId: { in: usageIds } }] : []),
							...(lotIds.length > 0 ? [{ lotId: { in: lotIds } }] : []),
						],
					},
				});
			}
			if (planIds.length > 0) {
				await tx.planAllocation.deleteMany({
					where: { planId: { in: planIds } },
				});
			}

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
					// 审计日志无外键，须先于组织显式清理
					await tx.auditLog.deleteMany({
						where: { organizationId: { in: orphanOrgIds } },
					});
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

/** Bearer 头快捷方式 */
export function bearer(token: string): { Authorization: string } {
	return { Authorization: `Bearer ${token}` };
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
