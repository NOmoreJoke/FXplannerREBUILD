"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useState } from "react";

/**
 * 仅客户端渲染的 React Query DevTools。
 *
 * v5 的 ReactQueryDevtools 在 SSR 阶段会抛 "No QueryClient set"，
 * 因此用 next/dynamic + ssr:false 强制只在浏览器加载。
 */
const ReactQueryDevtools = dynamic(
	() =>
		import("@tanstack/react-query-devtools").then((m) => m.ReactQueryDevtools),
	{
		ssr: false,
	},
);

/**
 * React Query Provider 组件
 * 为子组件提供 React Query 上下文
 *
 * 配置策略：
 * - staleTime: 5min - 5 分钟内数据视为新鲜，减少不必要的请求
 * - gcTime: 10min - 10 分钟后垃圾回收未使用的缓存
 * - refetchOnWindowFocus: true - 切换标签页自动重新验证
 * - retry: 1 - 失败后重试 1 次
 *
 * DevTools: 开发环境自动加载，生产环境不打包
 */
export function ReactQueryProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						staleTime: 5 * 60 * 1000, // 5 分钟内视为新鲜
						gcTime: 10 * 60 * 1000, // 10 分钟后垃圾回收
						refetchOnWindowFocus: true, // 窗口聚焦时刷新
						retry: 1, // 失败重试 1 次
					},
					mutations: {
						retry: 0, // Mutation 不重试
					},
				},
			}),
	);

	return (
		<QueryClientProvider client={queryClient}>
			{children}
			{process.env.NODE_ENV === "development" && (
				<ReactQueryDevtools initialIsOpen={false} />
			)}
		</QueryClientProvider>
	);
}
