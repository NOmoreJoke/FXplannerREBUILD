"use client";

import { useEffect } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useModels } from "@/lib/hooks/use-models";
import { useChatStore } from "@/lib/stores/chat-store";

interface ModelSelectorProps {
	/** 任意流进行中：禁用（单流交互约定，切换模型只对下一条消息生效） */
	disabled?: boolean;
}

/**
 * 模型选择器（ai-model-whitelist 方案 §5.2）：输入区左侧的下拉按钮，
 * 展示白名单模型（图标 + displayName + costTier 徽标），读写 store 的
 * selectedModel。
 *
 * - null = 跟随服务端默认：触发器显示列表首项（后端按 costTier 升序返回，
 *   首项即默认模型 GPT-4.1 Mini），但不写入 key——服务端默认变更时自动跟随；
 * - 自愈逻辑：列表加载后发现 selectedModel 不在白名单中（白名单缩编后
 *   localStorage 残留）则 setSelectedModel(null) 回退默认。
 */
export function ModelSelector({ disabled = false }: ModelSelectorProps) {
	const { data } = useModels();
	const items = data?.items ?? [];
	const selectedModel = useChatStore((s) => s.selectedModel);
	const setSelectedModel = useChatStore((s) => s.setSelectedModel);

	// 自愈：持久化的 key 已不在白名单（缩编/改名）→ 回退「跟随服务端默认」
	useEffect(() => {
		if (
			data !== undefined &&
			selectedModel !== null &&
			!data.items.some((item) => item.key === selectedModel)
		) {
			setSelectedModel(null);
		}
	}, [data, selectedModel, setSelectedModel]);

	// 触发器展示项：已选且仍在白名单 → 该项；否则列表首项（= 服务端默认）
	const current =
		items.find((item) => item.key === selectedModel) ?? items[0];

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={disabled}
					data-testid="model-selector-trigger"
					aria-label="选择模型"
					title={current ? `当前模型：${current.displayName}` : "选择模型"}
					className="gap-1.5"
				>
					{current !== undefined && (
						<span aria-hidden="true">{current.icon}</span>
					)}
					<span className="max-w-28 truncate">
						{current?.displayName ?? "选择模型"}
					</span>
					<ChevronsUpDown className="size-3.5 text-muted-foreground" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				{items.map((item) => (
					<DropdownMenuItem
						key={item.key}
						data-testid="model-selector-item"
						data-model-key={item.key}
						onSelect={() => setSelectedModel(item.key)}
						className="gap-2"
					>
						<span aria-hidden="true">{item.icon}</span>
						<span className="min-w-0 flex-1 truncate">{item.displayName}</span>
						<Badge variant="outline" title="成本档位">
							T{item.costTier}
						</Badge>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
