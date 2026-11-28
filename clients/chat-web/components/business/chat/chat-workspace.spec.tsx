import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api/client";
import { ChatWorkspace } from "./chat-workspace";

const { useConversationsMock, useModelsMock } = vi.hoisted(() => ({
	useConversationsMock: vi.fn(),
	useModelsMock: vi.fn(),
}));

vi.mock("@/lib/hooks/use-conversations", () => ({
	useConversations: useConversationsMock,
	useDeleteConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/hooks/use-chat", () => ({
	useChat: () => ({
		activeId: null,
		messages: [],
		isLoadingMessages: false,
		streamText: undefined,
		streamDraft: null,
		toolActive: false,
		activeToolName: null,
		anyStreaming: false,
		error: null,
		selectConversation: vi.fn(),
		send: vi.fn(),
		stop: vi.fn(),
	}),
}));

vi.mock("@/lib/hooks/use-models", () => ({
	useModels: useModelsMock,
	useModelSelection: () => ({
		items: [],
		current: undefined,
		setSelectedModel: vi.fn(),
	}),
}));

vi.mock("@/lib/hooks/use-organization-capabilities", () => ({
	useOrganizationCapabilities: () => ({
		can: () => true,
		isLoading: false,
	}),
}));

vi.mock("@/lib/hooks/use-organizations", () => ({
	useCurrentOrganization: () => ({
		data: {
			id: "org-1",
			name: "测试工作台",
			onboardingCompleted: true,
		},
		isError: false,
	}),
}));

vi.mock("@/lib/stores/chat-store", () => ({
	useChatStore: (selector: (s: { streamingIds: string[] }) => unknown) =>
		selector({ streamingIds: [] }),
}));

describe("ChatWorkspace（正常空态与 503 温和降级态）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("正常就绪无会话时保留既有空态结构（message-empty 与 暂无会话）", () => {
		useConversationsMock.mockReturnValue({
			data: { items: [] },
			isPending: false,
			error: null,
		});
		useModelsMock.mockReturnValue({
			data: { items: [], orgToolsEnabled: true },
			error: null,
		});

		render(<ChatWorkspace />);

		expect(screen.getByTestId("conversation-list").textContent).toContain(
			"暂无会话",
		);
		expect(screen.getByTestId("message-empty")).toBeTruthy();
		expect(screen.queryByTestId("chat-service-unavailable")).toBeNull();
		expect(screen.getByTestId("chat-org-tools-status").textContent).toBe(
			"组织只读与草稿工具已就绪",
		);
	});

	it("后端返回 503 AI_NOT_CONFIGURED 时展示温和说明卡并禁用输入框，不渲染红色报错条", () => {
		useConversationsMock.mockReturnValue({
			data: undefined,
			isPending: false,
			error: new ApiError(
				"AI 助手暂未配置，请联系管理员",
				503,
				"AI_NOT_CONFIGURED",
			),
		});
		useModelsMock.mockReturnValue({
			data: { items: [], orgToolsEnabled: true },
			error: null,
		});

		render(<ChatWorkspace />);

		expect(screen.getByTestId("chat-service-unavailable")).toBeTruthy();
		expect(screen.getByText("当前环境尚未配置 AI 模型服务")).toBeTruthy();
		expect(screen.getByTestId("chat-org-tools-status").textContent).toBe(
			"AI 服务待配置",
		);
		expect(screen.queryByTestId("chat-error")).toBeNull();
		expect(
			(screen.getByTestId("chat-input") as HTMLTextAreaElement).disabled,
		).toBe(true);
	});
});
