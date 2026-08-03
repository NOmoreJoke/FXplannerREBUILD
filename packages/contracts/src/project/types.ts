// Project 模块共享类型定义（前后端共用）

/**
 * Project 实体类型
 */
export interface Project {
  id: string;
  name: string;
  description: string | null;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Canvas 类型（Project 关联的 Canvas 实体）
 */
export interface Canvas {
  id: string;
  name: string;
  createdAt: string;
}

/**
 * 带 Canvas 的 Project（用于详情接口返回）
 */
export interface ProjectWithCanvas extends Project {
  canvases: Canvas[];
}

/**
 * 创建项目 DTO
 */
export interface CreateProjectDto {
  name: string;
  description?: string;
}

/**
 * 更新项目 DTO
 */
export interface UpdateProjectDto {
  name?: string;
  description?: string;
}

/**
 * 查询项目列表 DTO
 */
export interface QueryProjectsDto {
  page?: number;
  pageSize?: number;
  orderBy?: 'createdAt' | 'updatedAt' | 'name';
  order?: 'asc' | 'desc';
}

/**
 * 项目列表响应类型
 */
export interface ProjectsResponse {
  data: Project[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
}
