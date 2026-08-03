import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
	Project,
	CreateProjectDto,
	UpdateProjectDto,
} from "@fxplanner-new/contracts";
import { projectsApi } from "@/lib/api/projects";
import toast from "react-hot-toast";

/**
 * 项目列表查询 Key
 */
export const PROJECTS_QUERY_KEY = ["projects"];

/**
 * 查询项目列表
 * - 自动缓存 5 分钟
 * - 失败重试 1 次
 * - 窗口聚焦时后台刷新
 */
export function useProjects() {
	return useQuery({
		queryKey: PROJECTS_QUERY_KEY,
		queryFn: async () => {
			const response = await projectsApi.getAll();
			return response.data || [];
		},
	});
}

/**
 * 创建项目（乐观更新）
 */
export function useCreateProject() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (dto: CreateProjectDto) => projectsApi.create(dto),

		// 乐观更新：立即添加到列表
		onMutate: async (newProject) => {
			// 取消进行中的查询，避免覆盖乐观更新
			await queryClient.cancelQueries({ queryKey: PROJECTS_QUERY_KEY });

			// 快照当前数据
			const previousProjects =
				queryClient.getQueryData<Project[]>(PROJECTS_QUERY_KEY);

			// 乐观更新：临时 ID + 当前时间
			const optimisticProject: Project = {
				id: "temp-" + Date.now(),
				name: newProject.name,
				description: newProject.description ?? null,
				userId: "", // 后端返回后会更新
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};

			queryClient.setQueryData<Project[]>(PROJECTS_QUERY_KEY, (old) => {
				return [optimisticProject, ...(old || [])];
			});

			return { previousProjects };
		},

		// 失败回滚
		onError: (err: any, _newProject, context) => {
			if (context?.previousProjects) {
				queryClient.setQueryData(PROJECTS_QUERY_KEY, context.previousProjects);
			}
			toast.error(err.message || "创建项目失败");
		},

		// 成功提示
		onSuccess: () => {
			toast.success("项目创建成功");
		},

		// 无论成功失败，都重新获取真实数据
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
		},
	});
}

/**
 * 删除项目（乐观更新）
 */
export function useDeleteProject() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => projectsApi.delete(id),

		// 乐观更新：立即移除
		onMutate: async (deletedId) => {
			await queryClient.cancelQueries({ queryKey: PROJECTS_QUERY_KEY });

			const previousProjects =
				queryClient.getQueryData<Project[]>(PROJECTS_QUERY_KEY);

			queryClient.setQueryData<Project[]>(PROJECTS_QUERY_KEY, (old) => {
				return (old || []).filter((p) => p.id !== deletedId);
			});

			return { previousProjects };
		},

		onError: (err: any, _deletedId, context) => {
			if (context?.previousProjects) {
				queryClient.setQueryData(PROJECTS_QUERY_KEY, context.previousProjects);
			}
			toast.error(err.message || "删除项目失败");
		},

		onSuccess: () => {
			toast.success("项目删除成功");
		},

		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
		},
	});
}

/**
 * 更新项目（乐观更新）
 */
export function useUpdateProject() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, dto }: { id: string; dto: UpdateProjectDto }) =>
			projectsApi.update(id, dto),

		// 乐观更新：立即修改
		onMutate: async ({ id, dto }) => {
			await queryClient.cancelQueries({ queryKey: PROJECTS_QUERY_KEY });

			const previousProjects =
				queryClient.getQueryData<Project[]>(PROJECTS_QUERY_KEY);

			queryClient.setQueryData<Project[]>(PROJECTS_QUERY_KEY, (old) => {
				return (old || []).map((p) =>
					p.id === id
						? { ...p, ...dto, updatedAt: new Date().toISOString() }
						: p,
				);
			});

			return { previousProjects };
		},

		onError: (err: any, _variables, context) => {
			if (context?.previousProjects) {
				queryClient.setQueryData(PROJECTS_QUERY_KEY, context.previousProjects);
			}
			toast.error(err.message || "更新项目失败");
		},

		onSuccess: () => {
			toast.success("项目更新成功");
		},

		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
		},
	});
}
