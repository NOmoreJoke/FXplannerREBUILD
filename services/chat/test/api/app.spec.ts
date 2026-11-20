import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
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

it('测试应用在 IPv4 回环上持续监听同一端口，并在关闭时释放监听', async () => {
  const { app } = await createTestApp();
  const server = app.getHttpServer<Server>();
  try {
    const address = server.address();
    expect(address).toEqual({
      address: '127.0.0.1',
      family: 'IPv4',
      port: expect.toSatisfy((port: number) => port > 0),
    });

    await request(server).get('/api/health').expect(200, { ok: true });
    expect(server.address()).toEqual(address);
    await request(server).get('/api/health').expect(200, { ok: true });
    expect(server.address()).toEqual(address);
  } finally {
    await app.close();
  }
  expect(server.listening).toBe(false);
  expect(server.address()).toBeNull();
});
