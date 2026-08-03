import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, cleanupUser, bearer, TestContext } from '../helpers/test-app';

/**
 * 集成测试：跨模块业务流
 *
 * 与单 controller 的接口测试不同，这里验证多个模块串联的完整业务场景：
 * 注册(auth) → 登录(auth) → 创建资源(project) → 删除用户级联清理(prisma)
 */
describe('跨模块业务流（集成）', () => {
  let ctx: TestContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('完整生命周期：注册 → 登录 → 建项目 → 删用户级联清理', async () => {
    const email = `flow-${Date.now()}@example.com`;
    const password = 'FlowTest123';

    // 1. 注册
    const reg = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password, name: '流程测试' })
      .expect(201);
    const userId = reg.body.data.user.id;

    // 2. 登录拿 token
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(200);
    const token = login.body.data.accessToken;

    // 3. 带 token 创建项目
    const proj = await request(app.getHttpServer())
      .post('/api/projects')
      .set(bearer(token))
      .send({ name: '流程项目' })
      .expect(201);
    const projectId = proj.body.data.id;

    // 4. 项目列表能查到（数据真实落库并正确关联到该用户）
    const list = await request(app.getHttpServer())
      .get('/api/projects')
      .set(bearer(token))
      .expect(200);
    const items = Array.isArray(list.body.data) ? list.body.data : list.body.data.data;
    expect(items.some((p: { id: string }) => p.id === projectId)).toBe(true);

    // 5. 删除用户 → 项目应级联删除（Prisma onDelete: Cascade 跨模块约定）
    await cleanupUser(ctx.prisma, userId);
    const orphan = await ctx.prisma.project.findUnique({ where: { id: projectId } });
    expect(orphan).toBeNull();

    // 6. 级联后 token 虽未到期的请求也不应再拿到数据（用户已不存在）
    const after = await request(app.getHttpServer())
      .get('/api/projects')
      .set(bearer(token));
    expect([401, 200]).toContain(after.status);
    if (after.status === 200) {
      const afterItems = Array.isArray(after.body.data) ? after.body.data : after.body.data.data;
      expect(afterItems.length).toBe(0);
    }
  });
});
