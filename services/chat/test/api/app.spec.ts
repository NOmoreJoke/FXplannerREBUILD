import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from '../helpers/test-app';

/**
 * 接口测试 ↔ src/app.controller.ts
 * 系统探针：只保留 health，hello 示例接口已移除
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
    it('示例 hello 路由应该已经移除', () => {
      return request(app.getHttpServer()).get('/api/hello').expect(404);
    });
  });
});
