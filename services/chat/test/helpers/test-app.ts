import {
	Test,
	type TestingModule,
	type TestingModuleBuilder,
} from "@nestjs/testing";
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/prisma/prisma.service";

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
	await app.init();

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
	const password = "TestPass123";

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

/** 清理测试用户（项目等数据随用户级联删除） */
export async function cleanupUser(
	prisma: PrismaService,
	userId: string,
): Promise<void> {
	await prisma.user.delete({ where: { id: userId } }).catch(() => {});
}

/** Bearer 头快捷方式 */
export function bearer(token: string): { Authorization: string } {
	return { Authorization: `Bearer ${token}` };
}
