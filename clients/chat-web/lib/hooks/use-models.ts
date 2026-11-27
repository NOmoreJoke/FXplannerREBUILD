"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { chatApi } from "@/lib/api/chat";
import { queryKeys } from "@/lib/api/query-keys";
import { useChatStore } from "@/lib/stores/chat-store";

/**
 * 模型白名单消费层（ai-model-whitelist 方案 §5.2）：
 * GET /ai/models 的 react-query 封装，模型选择器与消息气泡角标的唯一数据源。
 */

/** 查询 Key 词根（[domain, action] 约定，与 conversations/messages 同构） */
export const AI_MODELS_QUERY_STEM = queryKeys.ai.models();

/** staleTime 5 分钟（LingJi 同值）：白名单为封闭集合，变更频率极低 */
const MODELS_STALE_TIME_MS = 5 * 60 * 1000;

/** 模型白名单列表（按 costTier 升序，首项即服务端默认模型） */
export function useModels() {
	return useQuery({
		queryKey: [...AI_MODELS_QUERY_STEM],
		queryFn: () => chatApi.listModels(),
		staleTime: MODELS_STALE_TIME_MS,
		retry: false, // 401 由 apiClient 统一处理；失败走错误分支
	});
}

/**
 * 模型选择器状态封装（含白名单自愈：持久化的 key 不再合法时回退「跟随服务端默认」）。
 */
export function useModelSelection() {
	const { data } = useModels();
	const items = data?.items ?? [];
	const selectedModel = useChatStore((s) => s.selectedModel);
	const setSelectedModel = useChatStore((s) => s.setSelectedModel);

	useEffect(() => {
		if (
			data !== undefined &&
			selectedModel !== null &&
			!data.items.some((item) => item.key === selectedModel)
		) {
			setSelectedModel(null);
		}
	}, [data, selectedModel, setSelectedModel]);

	const current =
		items.find((item) => item.key === selectedModel) ?? items[0];

	return { items, current, setSelectedModel };
}
