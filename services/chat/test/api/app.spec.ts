import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, TestContext } from '../helpers/test-app';

/**
 * 接口测试 ↔ src/app.controller.ts
 * 骨架探针：health 与共享包闭环（hello）
 */
describe('AppController（e2e）', () => {
  let ctx: TestContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/health', () => {
    it('应该返回服务状态', () => {
      return request(app.getHttpServer())
        .get('/api/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.ok).toBe(true);
        });
    });
  });

  describe('GET /api/hello', () => {
    it('应该返回共享包常量（验证 contracts 闭环）', () => {
      return request(app.getHttpServer())
        .get('/api/hello')
        .expect(200)
        .expect((res) => {
          expect(res.body.message).toContain('APP_NAME=');
        });
    });
  });
});
