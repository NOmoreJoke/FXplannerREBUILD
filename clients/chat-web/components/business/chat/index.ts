/**
 * AI 聊天工作台业务组件桶（components/business/chat）：
 * - ChatWorkspace：会话列表 + 对话区布局（状态编排组装入口）
 * - ConversationList：会话列表 / 切换 / 删除（确认弹窗）
 * - MessageList：消息流渲染 + 自动滚动（流式气泡与工具提示）
 * - MessageBubble：消息气泡（纯文本渲染 + 流式光标，禁 innerHTML）
 * - ChatInput：输入框（Enter 发送 / 流式禁发 / 停止生成）
 * - ModelSelector：模型选择器（白名单下拉 / 持久化偏好 / 白名单缩编自愈）
 * - PlanDraftCard：计划草稿建议卡（未保存提示 / 权限门控 / 跳转确认页）
 */
export { ChatWorkspace } from "./chat-workspace";
export { ConversationList } from "./conversation-list";
export { MessageList } from "./message-list";
export { MessageBubble } from "./message-bubble";
export { ChatInput } from "./chat-input";
export { ModelSelector } from "./model-selector";
export { PlanDraftCard } from "./plan-draft-card";
