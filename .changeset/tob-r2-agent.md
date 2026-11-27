---
"@fxplanner-new/chat": minor
"@fxplanner-new/chat-web": minor
---

ToB R2 可控组织 Agent（P7 组织只读 Agent 工具 + P8 计划草稿与人工确认闭环 · W33–W36）：

- **组织只读 Agent 工具与实时鉴权守卫（W33 / P7）**：新增 `get_account_summary`、`list_plan_exposure`、`get_plan_cost_summary`、`list_upcoming_actions` 四项组织只读工具及统一 `tool-guard.ts`（调用前实时校验个人/组织双锁、重查 `Membership`、校验 `AI_ORG_TOOLS_ENABLED` 独立降级开关与集中策略 `can(role, perm)`，并落盘 `actorType="AGENT"` + `agentRunId` 审计日志）；全部 6 个工具使用 `.strict()` schema 且禁含身份/组织越权入参。
- **计划草稿与人工确认闭环（W34 / P8）**：新增只读预览工具 `draft_fx_plan`（仅调用 `PlanService.preview`，零写 `Plan`）、`ai_messages.plan_draft` 可空 JSONB 列迁移（`20261127010000_tob_r2_ai_message_plan_draft`）、SSE `draft` 帧、前端 `ChatWorkspace` 组织标识/工具状态、`PlanDraftCard`（绑定 `sourceOrgId` 防切组织串用草稿）及 `/plans/new` 最新可分配上限实时重检与 `CreatePlanDto.agentRunId` 审计串联。
- **全层测试、E2E 假流 ReAct 与文档收口（W35–W36）**：新增 `agent-tools.spec.ts`（10）、`agent-tool-authorization.spec.ts`（5）、扩展 `ai-chat.spec.ts` / `prisma.spec.ts`、`E2eFakeAgentChatModel`（`[R2-E2E]` 真实 ReAct 工具链）与 `e2e/modules/16-agent-organization.spec.ts`（`GWT-19..25`, `GWT-13`, `GWT-29`），完成 D6 独立对抗审闭环与 R2 验收记录。
