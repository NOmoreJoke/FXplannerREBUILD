import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, createTestUser, cleanupUser, bearer, TestContext, TestUser } from '../helpers/test-app';

/**
 * 接口测试 ↔ src/auth/auth.controller.ts
 * 认证骨架：注册 / 登录 / getMe / 鉴权边界
 */
describe('AuthController（e2e）', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let user: TestUser;

  const EMAIL = `auth-${Date.now()}@example.com`;
  const PASSWORD = 'AuthTest123';

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    if (user) await cleanupUser(ctx.prisma, user.userId);
    await app.close();
  });

  describe('POST /api/auth/register', () => {
    it('应该成功注册并返回 token', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: '认证测试' })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.user.email).toBe(EMAIL);
    });

    it('重复注册同邮箱应该失败', () => {
      return request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ email: EMAIL, password: PASSWORD })
        .expect((res) => {
          expect(res.status).toBeGreaterThanOrEqual(400);
        });
    });

    it('弱密码应该 400', () => {
      return request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ email: `weak-${Date.now()}@example.com`, password: '123' })
        .expect(400);
    });
  });

  describe('POST /api/auth/login', () => {
    it('应该成功登录并返回 JWT', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.user.id).toBeDefined();

      user = {
        email: EMAIL,
        password: PASSWORD,
        accessToken: res.body.data.accessToken,
        userId: res.body.data.user.id,
      };
    });

    it('错误密码应该 401', () => {
      return request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: EMAIL, password: 'wrong-password' })
        .expect(401);
    });
  });

  describe('GET /api/auth/me', () => {
    it('带 token 应该返回当前用户', async () => {
      const me = await createTestUser(app, 'me');
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set(bearer(me.accessToken))
        .expect(200);

      expect(res.body.data.email).toBe(me.email);
      await cleanupUser(ctx.prisma, me.userId);
    });

    it('无 token 应该 401', () => {
      return request(app.getHttpServer()).get('/api/auth/me').expect(401);
    });
  });
});
