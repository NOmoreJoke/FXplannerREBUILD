import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, createTestUser, cleanupUser, bearer, TestContext, TestUser } from '../helpers/test-app';

/**
 * 接口测试 ↔ src/project/project.controller.ts
 * 示例模块 CRUD：JWT 鉴权边界 + 数据正确往返
 */
describe('ProjectController（e2e）', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let user: TestUser;
  let projectId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    user = await createTestUser(app, 'project');
  });

  afterAll(async () => {
    await cleanupUser(ctx.prisma, user.userId);
    await app.close();
  });

  describe('JWT 鉴权边界', () => {
    it('无 token 访问应该 401', () => {
      return request(app.getHttpServer()).get('/api/projects').expect(401);
    });
  });

  describe('POST /api/projects', () => {
    it('应该成功创建项目', () => {
      return request(app.getHttpServer())
        .post('/api/projects')
        .set(bearer(user.accessToken))
        .send({ name: '接口测试项目', description: 'CRUD 往返验证' })
        .expect(201)
        .expect((res) => {
          expect(res.body.success).toBe(true);
          expect(res.body.data.name).toBe('接口测试项目');
          projectId = res.body.data.id;
        });
    });

    it('空项目名应该 400', () => {
      return request(app.getHttpServer())
        .post('/api/projects')
        .set(bearer(user.accessToken))
        .send({ name: '', description: 'x' })
        .expect(400);
    });
  });

  describe('GET /api/projects', () => {
    it('应该返回分页结构且包含新建项目', () => {
      return request(app.getHttpServer())
        .get('/api/projects')
        .set(bearer(user.accessToken))
        .expect(200)
        .expect((res) => {
          const payload = res.body.data;
          const list = Array.isArray(payload) ? payload : payload.data;
          expect(Array.isArray(list)).toBe(true);
          expect(list.some((p: { id: string }) => p.id === projectId)).toBe(true);
        });
    });
  });

  describe('GET /api/projects/:id', () => {
    it('应该返回项目详情', () => {
      return request(app.getHttpServer())
        .get(`/api/projects/${projectId}`)
        .set(bearer(user.accessToken))
        .expect(200)
        .expect((res) => {
          expect(res.body.data.id).toBe(projectId);
          expect(res.body.data.description).toBe('CRUD 往返验证');
        });
    });

    it('访问不存在的项目应该 404', () => {
      return request(app.getHttpServer())
        .get('/api/projects/non-existent-id')
        .set(bearer(user.accessToken))
        .expect(404);
    });

    it('访问其他用户的项目应该 403', async () => {
      const other = await createTestUser(app, 'other');
      const res = await request(app.getHttpServer())
        .post('/api/projects')
        .set(bearer(other.accessToken))
        .send({ name: '他人项目' })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/projects/${res.body.data.id}`)
        .set(bearer(user.accessToken))
        .expect(403);

      await cleanupUser(ctx.prisma, other.userId);
    });
  });

  describe('PATCH /api/projects/:id', () => {
    it('更新应该生效', () => {
      return request(app.getHttpServer())
        .patch(`/api/projects/${projectId}`)
        .set(bearer(user.accessToken))
        .send({ name: '接口测试项目-已更新' })
        .expect(200)
        .expect((res) => {
          expect(res.body.data.name).toBe('接口测试项目-已更新');
        });
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('删除后再查应该 404', async () => {
      await request(app.getHttpServer())
        .delete(`/api/projects/${projectId}`)
        .set(bearer(user.accessToken))
        .expect(200);

      return request(app.getHttpServer())
        .get(`/api/projects/${projectId}`)
        .set(bearer(user.accessToken))
        .expect(404);
    });
  });
});
