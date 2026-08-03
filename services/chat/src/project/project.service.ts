import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto, UpdateProjectDto, QueryProjectsDto } from './dto';

/**
 * 示例业务模块（L2）：Project CRUD
 *
 * 演示模板的标准分层：controller → service → prisma。
 * 本模块满足「可删除性」四标准，新项目可用 `bun run prune example` 一键移除。
 */
@Injectable()
export class ProjectService {
  constructor(private prisma: PrismaService) {}

  /**
   * 创建项目
   */
  async create(userId: string, dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: {
        userId,
        name: dto.name,
        description: dto.description,
      },
    });
  }

  /**
   * 查询当前用户的项目列表（分页、排序、过滤已删除）
   */
  async findAll(userId: string, query: QueryProjectsDto) {
    const { page = 1, pageSize = 20, orderBy = 'updatedAt', order = 'desc' } = query;

    // 1. 查询总数
    const total = await this.prisma.project.count({
      where: {
        userId,
        isDeleted: false,
      },
    });

    // 2. 查询项目列表
    const projects = await this.prisma.project.findMany({
      where: {
        userId,
        isDeleted: false,
      },
      orderBy: {
        [orderBy]: order,
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // 3. 返回分页数据
    return {
      data: projects,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  /**
   * 查询单个项目（权限验证）
   */
  async findOne(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project || project.isDeleted) {
      throw new NotFoundException('项目不存在');
    }

    if (project.userId !== userId) {
      throw new ForbiddenException('无权访问此项目');
    }

    return project;
  }

  /**
   * 更新项目（权限验证）
   */
  async update(userId: string, projectId: string, dto: UpdateProjectDto) {
    // 1. 验证权限
    await this.findOne(userId, projectId);

    // 2. 更新项目
    return this.prisma.project.update({
      where: { id: projectId },
      data: dto,
    });
  }

  /**
   * 软删除项目
   */
  async remove(userId: string, projectId: string) {
    // 1. 验证权限
    await this.findOne(userId, projectId);

    // 2. 软删除项目
    return this.prisma.project.update({
      where: { id: projectId },
      data: { isDeleted: true },
    });
  }
}
