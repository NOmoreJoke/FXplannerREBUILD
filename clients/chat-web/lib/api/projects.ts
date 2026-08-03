import { apiClient } from './client';
import type {
  Project,
  Canvas,
  ProjectWithCanvas,
  CreateProjectDto,
  UpdateProjectDto,
  ProjectsResponse,
  QueryProjectsDto,
} from '@fxplanner-new/contracts';

export const projectsApi = {
  /**
   * 创建项目
   */
  async create(dto: CreateProjectDto): Promise<ProjectWithCanvas> {
    return apiClient<ProjectWithCanvas>('/projects', {
      method: 'POST',
      body: JSON.stringify(dto),
    });
  },

  /**
   * 查询项目列表
   */
  async getAll(query?: QueryProjectsDto): Promise<ProjectsResponse> {
    const params = new URLSearchParams();
    if (query?.page) params.append('page', query.page.toString());
    if (query?.pageSize) params.append('pageSize', query.pageSize.toString());
    if (query?.orderBy) params.append('orderBy', query.orderBy);
    if (query?.order) params.append('order', query.order);

    const queryString = params.toString();
    const endpoint = queryString ? `/projects?${queryString}` : '/projects';

    return apiClient<ProjectsResponse>(endpoint, {
      method: 'GET',
    });
  },

  /**
   * 查询单个项目
   */
  async getOne(id: string): Promise<ProjectWithCanvas> {
    return apiClient<ProjectWithCanvas>(`/projects/${id}`, {
      method: 'GET',
    });
  },

  /**
   * 更新项目
   */
  async update(id: string, dto: UpdateProjectDto): Promise<Project> {
    return apiClient<Project>(`/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    });
  },

  /**
   * 删除项目
   */
  async delete(id: string): Promise<void> {
    return apiClient<void>(`/projects/${id}`, {
      method: 'DELETE',
    });
  },
};
