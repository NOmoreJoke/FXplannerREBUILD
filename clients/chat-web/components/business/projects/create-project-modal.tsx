"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

const createProjectSchema = z.object({
	name: z
		.string()
		.min(1, "项目名称不能为空")
		.max(100, "项目名称不能超过 100 个字符"),
	description: z.string().max(500, "项目描述不能超过 500 个字符").optional(),
});

type CreateProjectFormData = z.infer<typeof createProjectSchema>;

interface CreateProjectModalProps {
	isOpen: boolean;
	onClose: () => void;
	onCreate: (data: CreateProjectFormData) => void;
	isLoading?: boolean;
}

export function CreateProjectModal({
	isOpen,
	onClose,
	onCreate,
	isLoading = false,
}: CreateProjectModalProps) {
	const {
		register,
		handleSubmit,
		formState: { errors },
		reset,
	} = useForm<CreateProjectFormData>({
		resolver: zodResolver(createProjectSchema),
	});

	const onSubmit = (data: CreateProjectFormData) => {
		onCreate(data);
		reset();
	};

	const handleClose = () => {
		if (!isLoading) {
			reset();
			onClose();
		}
	};

	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			{/* 遮罩层 */}
			<div
				className="fixed inset-0 bg-black bg-opacity-50"
				onClick={handleClose}
			/>

			{/* 模态框内容 */}
			<div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4 p-6">
				{/* 头部 */}
				<div className="flex items-center justify-between mb-6">
					<h2 className="text-xl font-semibold text-gray-900">创建新项目</h2>
					<button
						onClick={handleClose}
						className="text-gray-400 hover:text-gray-600"
						disabled={isLoading}
					>
						<svg
							className="w-6 h-6"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>

				{/* 表单 */}
				<form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
					{/* 项目名称 */}
					<div>
						<label
							htmlFor="name"
							className="block text-sm font-medium text-gray-700 mb-2"
						>
							项目名称 <span className="text-red-500">*</span>
						</label>
						<input
							id="name"
							type="text"
							{...register("name")}
							className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
							placeholder="输入项目名称"
							disabled={isLoading}
							autoFocus
						/>
						{errors.name && (
							<p className="mt-1 text-sm text-red-600">{errors.name.message}</p>
						)}
					</div>

					{/* 项目描述 */}
					<div>
						<label
							htmlFor="description"
							className="block text-sm font-medium text-gray-700 mb-2"
						>
							项目描述（可选）
						</label>
						<textarea
							id="description"
							{...register("description")}
							className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
							placeholder="简要描述项目用途"
							rows={3}
							disabled={isLoading}
						/>
						{errors.description && (
							<p className="mt-1 text-sm text-red-600">
								{errors.description.message}
							</p>
						)}
					</div>

					{/* 按钮 */}
					<div className="flex justify-end space-x-3 pt-4">
						<button
							type="button"
							onClick={handleClose}
							className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
							disabled={isLoading}
						>
							取消
						</button>
						<button
							type="submit"
							className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
							disabled={isLoading}
							data-testid="create-project-submit"
						>
							{isLoading ? "创建中..." : "创建"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
