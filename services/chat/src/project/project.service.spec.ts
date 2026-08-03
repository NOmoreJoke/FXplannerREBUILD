import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ProjectService } from './project.service';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';

describe('ProjectService', () => {
  let service: ProjectService;
  let prisma: PrismaService;
  let testUserId: string;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [ProjectService],
    }).compile();

    service = module.get<ProjectService>(ProjectService);
    prisma = module.get<PrismaService>(PrismaService);

    // 创建测试用户
    const testUser = await prisma.user.create({
      data: {
        email: `test-${Date.now()}@example.com`,
        passwordHash: 'test-hash',
        name: '测试用户',
      },
    });
    testUserId = testUser.id;
  });

  afterEach(async () => {
    // 清理测试数据
    await prisma.project.deleteMany({
      where: { userId: testUserId },
    });
    await prisma.user.delete({
      where: { id: testUserId },
    });
  });

  describe('create', () => {
    it('应该成功创建项目', async () => {
      const dto = { name: '测试项目', description: '测试描述' };
      const result = await service.create(testUserId, dto);

      expect(result.name).toBe(dto.name);
      expect(result.description).toBe(dto.description);
      expect(result.userId).toBe(testUserId);
    });

    it('应该支持不传描述', async () => {
      const dto = { name: '测试项目' };
      const result = await service.create(testUserId, dto);

      expect(result.name).toBe(dto.name);
      expect(result.description).toBeNull();
    });
  });

  describe('findAll', () => {
    beforeEach(async () => {
      // 创建多个测试项目
      await prisma.project.createMany({
        data: [
          { userId: testUserId, name: '项目1', description: '描述1' },
          { userId: testUserId, name: '项目2', description: '描述2' },
          { userId: testUserId, name: '项目3', description: '描述3', isDeleted: true },
        ],
      });
    });

    it('应该只返回当前用户的项目', async () => {
      const result = await service.findAll(testUserId, {
        page: 1,
        pageSize: 20,
      });

      expect(result.data).toBeDefined();
      expect(result.data.length).toBeGreaterThanOrEqual(2);
      result.data.forEach((project) => {
        expect(project).toHaveProperty('id');
        expect(project).toHaveProperty('name');
      });
    });

    it('应该排除已删除的项目', async () => {
      const result = await service.findAll(testUserId, {
        page: 1,
        pageSize: 20,
      });

      const deletedProject = result.data.find((p) => p.name === '项目3');
      expect(deletedProject).toBeUndefined();
    });

    it('应该支持分页', async () => {
      const result = await service.findAll(testUserId, {
        page: 1,
        pageSize: 1,
      });

      expect(result.data.length).toBeLessThanOrEqual(1);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.pageSize).toBe(1);
      expect(result.pagination.total).toBeGreaterThanOrEqual(2);
    });

    it('应该按更新时间倒序排序', async () => {
      const result = await service.findAll(testUserId, {
        page: 1,
        pageSize: 10,
        orderBy: 'updatedAt',
        order: 'desc',
      });

      if (result.data.length >= 2) {
        const first = new Date(result.data[0].updatedAt);
        const second = new Date(result.data[1].updatedAt);
        expect(first.getTime()).toBeGreaterThanOrEqual(second.getTime());
      }
    });
  });

  describe('findOne', () => {
    it('应该返回项目详情', async () => {
      const project = await prisma.project.create({
        data: {
          userId: testUserId,
          name: '单个项目测试',
          description: '测试描述',
        },
      });

      const result = await service.findOne(testUserId, project.id);

      expect(result.id).toBe(project.id);
      expect(result.name).toBe('单个项目测试');
      expect(result.description).toBe('测试描述');
    });

    it('应该拒绝访问不存在的项目', async () => {
      await expect(service.findOne(testUserId, 'non-existent-id')).rejects.toThrow(
        '项目不存在',
      );
    });

    it('应该拒绝访问其他用户的项目', async () => {
      const otherUser = await prisma.user.create({
        data: {
          email: `other-${Date.now()}@example.com`,
          passwordHash: 'test-hash',
        },
      });

      const otherProject = await prisma.project.create({
        data: {
          userId: otherUser.id,
          name: '其他用户的项目',
        },
      });

      await expect(service.findOne(testUserId, otherProject.id)).rejects.toThrow(
        '无权访问此项目',
      );

      // 清理
      await prisma.project.delete({ where: { id: otherProject.id } });
      await prisma.user.delete({ where: { id: otherUser.id } });
    });
  });

  describe('update', () => {
    it('应该成功更新项目', async () => {
      const project = await prisma.project.create({
        data: {
          userId: testUserId,
          name: '待更新项目',
          description: '原始描述',
        },
      });

      const result = await service.update(testUserId, project.id, {
        name: '已更新项目',
      });

      expect(result.name).toBe('已更新项目');
      expect(result.description).toBe('原始描述');
    });

    it('应该拒绝更新其他用户的项目', async () => {
      const otherUser = await prisma.user.create({
        data: {
          email: `other-${Date.now()}@example.com`,
          passwordHash: 'test-hash',
        },
      });

      const otherProject = await prisma.project.create({
        data: {
          userId: otherUser.id,
          name: '其他用户项目',
        },
      });

      await expect(
        service.update(testUserId, otherProject.id, { name: '尝试修改' }),
      ).rejects.toThrow('无权访问此项目');

      // 清理
      await prisma.project.delete({ where: { id: otherProject.id } });
      await prisma.user.delete({ where: { id: otherUser.id } });
    });
  });

  describe('remove', () => {
    it('应该软删除项目', async () => {
      const project = await prisma.project.create({
        data: {
          userId: testUserId,
          name: '待删除项目',
        },
      });

      await service.remove(testUserId, project.id);

      const deletedProject = await prisma.project.findUnique({
        where: { id: project.id },
      });
      expect(deletedProject?.isDeleted).toBe(true);
    });

    it('应该拒绝删除其他用户的项目', async () => {
      const otherUser = await prisma.user.create({
        data: {
          email: `other-${Date.now()}@example.com`,
          passwordHash: 'test-hash',
        },
      });

      const otherProject = await prisma.project.create({
        data: {
          userId: otherUser.id,
          name: '其他用户项目',
        },
      });

      await expect(service.remove(testUserId, otherProject.id)).rejects.toThrow(
        '无权访问此项目',
      );

      // 清理
      await prisma.project.delete({ where: { id: otherProject.id } });
      await prisma.user.delete({ where: { id: otherUser.id } });
    });
  });
});
