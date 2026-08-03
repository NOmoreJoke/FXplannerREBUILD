import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

let testUserId: string;

beforeAll(async () => {
  // 创建测试用户（所有用例共享）
  const user = await prisma.user.create({
    data: {
      email: `infra-test-${Date.now()}@example.com`,
      passwordHash: 'test-hash',
      name: '基础设施测试用户',
    },
  });
  testUserId = user.id;
});

afterAll(async () => {
  // 清理测试数据（级联删除项目）
  await prisma.user.delete({ where: { id: testUserId } });
  await prisma.$disconnect();
});

describe('数据库基础设施测试', () => {
  // ==================== 用户操作 ====================
  describe('用户操作', () => {
    test('查询用户', async () => {
      const user = await prisma.user.findUnique({
        where: { id: testUserId },
      });

      expect(user).toBeDefined();
      expect(user!.email).toContain('@example.com');
      expect(user!.createdAt).toBeInstanceOf(Date);
    });

    test('更新用户', async () => {
      const updated = await prisma.user.update({
        where: { id: testUserId },
        data: { name: '更新后的名字' },
      });

      expect(updated.name).toBe('更新后的名字');
    });
  });

  // ==================== 项目操作 ====================
  describe('项目操作', () => {
    test('创建项目', async () => {
      const project = await prisma.project.create({
        data: {
          userId: testUserId,
          name: '测试项目',
          description: '测试描述',
        },
      });

      expect(project.id).toBeDefined();
      expect(project.name).toBe('测试项目');
      expect(project.createdAt).toBeInstanceOf(Date);
    });

    test('查询用户的项目列表', async () => {
      const projects = await prisma.project.findMany({
        where: { userId: testUserId },
      });

      expect(projects.length).toBeGreaterThan(0);
    });

    test('删除用户时级联删除项目', async () => {
      // 独立创建一个用户 + 项目，验证 onDelete: Cascade
      const user = await prisma.user.create({
        data: {
          email: `cascade-${Date.now()}@example.com`,
          passwordHash: 'test-hash',
          projects: {
            create: { name: '级联测试项目' },
          },
        },
        include: { projects: true },
      });

      await prisma.user.delete({ where: { id: user.id } });

      const projects = await prisma.project.findMany({
        where: { userId: user.id },
      });
      expect(projects.length).toBe(0);
    });
  });

  // ==================== 事务 ====================
  describe('事务', () => {
    test('事务内多步写入，全部成功才提交', async () => {
      const result = await prisma.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: { userId: testUserId, name: '事务项目' },
        });
        const updated = await tx.project.update({
          where: { id: project.id },
          data: { description: '事务内更新' },
        });
        return updated;
      });

      expect(result.description).toBe('事务内更新');

      // 清理
      await prisma.project.delete({ where: { id: result.id } });
    });
  });
});
