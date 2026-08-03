"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/stores/auth-store";
import {
	ProjectCard,
	CreateProjectModal,
} from "@/components/business/projects";
import { PageLoading } from "@/components/base";
import {
	useProjects,
	useCreateProject,
	useDeleteProject,
	useUpdateProject,
} from "@/lib/query/hooks/use-projects";
import { useLogout } from "@/lib/query/hooks/use-auth";

export default function ProjectsPage() {
	const router = useRouter();
	const { user, clearUser } = useAuthStore();

	// React Query hooks
	const { data: projects = [], isLoading: isLoadingProjects } = useProjects();
	const createProject = useCreateProject();
	const deleteProject = useDeleteProject();
	const updateProject = useUpdateProject();
	const logout = useLogout();

	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

	const handleCreateProject = (data: {
		name: string;
		description?: string;
	}) => {
		createProject.mutate(data, {
			onSuccess: () => {
				setIsCreateModalOpen(false);
			},
		});
	};

	const handleDeleteProject = (id: string) => {
		if (!confirm("确定要删除这个项目吗？")) return;
		deleteProject.mutate(id);
	};

	const handleRenameProject = (id: string, newName: string) => {
		updateProject.mutate({ id, dto: { name: newName } });
	};

	const handleLogout = () => {
		logout();
		clearUser();
		router.push("/login");
	};

	return (
		<div className="min-h-screen bg-gray-50">
			{/* 顶部导航 */}
			<header className="bg-white border-b border-gray-200">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
					<div className="flex justify-between items-center h-16">
						<h1 className="text-2xl font-bold text-gray-900">FXPlanner-new</h1>
						<div className="flex items-center gap-4">
							<span className="text-sm text-gray-600">{user?.email}</span>
							<button
								onClick={handleLogout}
								className="text-sm text-gray-600 hover:text-gray-900"
							>
								退出登录
							</button>
						</div>
					</div>
				</div>
			</header>

			<main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
				{/* 页面标题和创建按钮 */}
				<div className="flex justify-between items-center mb-8">
					<h2 className="text-3xl font-bold text-gray-900">我的项目</h2>
					<button
						onClick={() => setIsCreateModalOpen(true)}
						className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-2"
					>
						+ 创建项目
					</button>
				</div>

				{/* 项目列表 */}
				{isLoadingProjects ? (
					<PageLoading className="min-h-0 py-12" />
				) : projects.length === 0 ? (
					<div className="text-center py-12">
						<svg
							className="mx-auto h-12 w-12 text-gray-400"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
							/>
						</svg>
						<h3 className="mt-2 text-sm font-medium text-gray-900">暂无项目</h3>
						<p className="mt-1 text-sm text-gray-500">
							创建您的第一个项目开始使用
						</p>
						<div className="mt-6">
							<button
								onClick={() => setIsCreateModalOpen(true)}
								className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
							>
								+ 创建项目
							</button>
						</div>
					</div>
				) : (
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
						{projects.map((project) => (
							<ProjectCard
								key={project.id}
								id={project.id}
								name={project.name}
								description={project.description}
								updatedAt={project.updatedAt}
								onDelete={handleDeleteProject}
								onRename={handleRenameProject}
							/>
						))}
					</div>
				)}
			</main>

			{/* 创建项目模态框 */}
			<CreateProjectModal
				isOpen={isCreateModalOpen}
				onClose={() => setIsCreateModalOpen(false)}
				onCreate={handleCreateProject}
				isLoading={createProject.isPending}
			/>
		</div>
	);
}
