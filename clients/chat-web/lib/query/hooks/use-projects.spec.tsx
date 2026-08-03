import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	useProjects,
	useCreateProject,
	useDeleteProject,
	useUpdateProject,
} from "./use-projects";
import { projectsApi } from "@/lib/api/projects";
import type { Project } from "@fxplanner-new/contracts";
import type React from "react";

// Mock projectsApi
vi.mock("@/lib/api/projects", () => ({
	projectsApi: {
		getAll: vi.fn(),
		create: vi.fn(),
		delete: vi.fn(),
		update: vi.fn(),
	},
}));

// Mock react-hot-toast
vi.mock("react-hot-toast", () => ({
	default: {
		success: vi.fn(),
		error: vi.fn(),
	},
}));

const createWrapper = () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
};

describe("useProjects", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("应成功查询项目列表", async () => {
		const mockProjects: Project[] = [
			{
				id: "1",
				name: "Test Project",
				description: "Description",
				userId: "user1",
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-01-01T00:00:00Z",
			},
		];

		vi.mocked(projectsApi.getAll).mockResolvedValue({
			data: mockProjects,
			pagination: { total: 1, page: 1, pageSize: 10, totalPages: 1 },
		});

		const { result } = renderHook(() => useProjects(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data).toEqual(mockProjects);
		expect(projectsApi.getAll).toHaveBeenCalledOnce();
	});

	it("查询失败时应返回错误状态", async () => {
		vi.mocked(projectsApi.getAll).mockRejectedValue(new Error("Network error"));

		const { result } = renderHook(() => useProjects(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isError).toBe(true));

		expect(result.current.error).toBeDefined();
	});
});

describe("useCreateProject", () => {
	it("应成功创建项目并触发乐观更新", async () => {
		const newProject = { name: "New Project", description: "New Description" };
		const createdProject = {
			id: "2",
			name: newProject.name,
			description: newProject.description,
			userId: "user1",
			createdAt: "2024-01-02T00:00:00Z",
			updatedAt: "2024-01-02T00:00:00Z",
			canvases: [],
		};

		vi.mocked(projectsApi.create).mockResolvedValue(createdProject);

		const { result } = renderHook(() => useCreateProject(), {
			wrapper: createWrapper(),
		});

		result.current.mutate(newProject);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(projectsApi.create).toHaveBeenCalledWith(newProject);
	});
});

describe("useDeleteProject", () => {
	it("应成功删除项目", async () => {
		vi.mocked(projectsApi.delete).mockResolvedValue();

		const { result } = renderHook(() => useDeleteProject(), {
			wrapper: createWrapper(),
		});

		result.current.mutate("1");

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(projectsApi.delete).toHaveBeenCalledWith("1");
	});
});

describe("useUpdateProject", () => {
	it("应成功更新项目", async () => {
		const updatedProject = {
			id: "1",
			name: "Updated Name",
			description: null,
			userId: "user1",
			createdAt: "2024-01-01T00:00:00Z",
			updatedAt: "2024-01-02T00:00:00Z",
		};

		vi.mocked(projectsApi.update).mockResolvedValue(updatedProject);

		const { result } = renderHook(() => useUpdateProject(), {
			wrapper: createWrapper(),
		});

		result.current.mutate({ id: "1", dto: { name: "Updated Name" } });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(projectsApi.update).toHaveBeenCalledWith("1", {
			name: "Updated Name",
		});
	});
});
