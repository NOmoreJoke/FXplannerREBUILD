# Goal #4 — FXplannerREBUILD · ToB R2 可控组织 Agent（P7–P8 / W33–W36）

> 适用阶段：Phase 4 · ToB R2（对应 `技术方案.md` P7 组织只读 Agent 工具 + P8 计划草稿与人工确认闭环）
> 接力序列：`Goal #3A (P1–P3)` → `Goal #3B (P4–P5)` → `Goal #3C (P6)` → **`Goal #4 (W33–W36)`**
> 上游真源：`AGENTS.md`、`docs/VERIFY.md`、`changes/tob-agent-workspace/需求文档.md`（§9 `AGENT-01..04`, §10 `AUDIT-01..03`, §15.4 `GWT-19..25`, §15.5 `GWT-29`）、`changes/tob-agent-workspace/技术方案.md`（§7.4, §8, §10.2, §14, §15.2 `P7–P8`）、`docs/ITERATION-REFACTOR-ROADMAP-20261119.md`
> 交付分支：`feat/tob-r2-agent`（切自 `dev` `64fc154`）→ **Draft PR → `dev`**

---

## 1. 目标与核心不变量

1. **工具边界最小权限与防提示注入（`AGENT-02` / `AGENT-04`）**：
   - 全 6 个 Agent 工具（1 个公共汇率 + 4 个组织只读 + 1 个只读草稿预览）的 zod schema 一律 `.strict()`，严格禁止出现 `userId`、`organizationId`、`orgId`、`membershipId`、`role`、`permission`、`actor` 入参；
   - 所有服务层调用的 `ActorContext` 仅来自请求鉴权闭包，经 `tool-guard.ts` 执行前实时核查：① 个人/组织双锁；② 实时重查 `Membership`（流中途降权/移除立即失效）；③ `AI_ORG_TOOLS_ENABLED` 独立降级开关（关闭时拦截组织工具、放行公共汇率）；④ 集中策略 `can(freshRole, perm)`；⑤ 写入 `AuditLog(actorType="AGENT", agentRunId)`。
2. **数据诚实与不可信文本隔离（`GWT-24`, `GWT-25`）**：
   - 复用 `AccountService`、`PlanService`、`ReportService`、`ReminderService` 与首页同一口径；
   - `hasUnknownFee=true`、`null` 成本与空组织（`empty=true`）原样透传，严禁编造或将未知费用当作 0；
   - `AI_SYSTEM_PROMPT` 保持纯静态文本；用户可编辑计划名称以 `untrustedPlanName` + `untrustedDataNotice` 包裹输出。
3. **草稿绝不自动入账与实时复核闭环（`AGENT-03`, `GWT-21..23`, `GWT-29`）**：
   - `draft_fx_plan` 仅调 `PlanService.preview`，严禁写 `Plan`；SSE 下发 `draft` 帧并存可空 `ai_messages.plan_draft` JSONB；
   - 前端 `PlanDraftCard` 携带 `sourceOrgId` 与 `agentRunId` 跳转 `/plans/new`；`parsePlanDraftQuery` 强制校验 `sourceOrgId === activeOrgId` 防止切组织串用草稿；
   - 确认页实时重算 `caps.maxAllocatable`，余额不足时显式告警并阻断直接提交；提交时通过 `CreatePlanDto.agentRunId` 将人工作确认的 `plan.create` 审计与 `agent.tool.draft_fx_plan` 同 `agentRunId` 关联。

## 2. 切片清单与验收结果

- **W33（`2c6f340`）**：`AccountModule`/`PlanModule`/`ReportModule` 导出服务、`AI_ORG_TOOLS_ENABLED`/`AI_SEND_THROTTLE_LIMIT`、`tool-guard.ts`、`rate-tool.ts`（`.strict()` + guard）、4 个组织只读工具（`account-summary-tool.ts`、`plan-exposure-tool.ts`、`plan-cost-tool.ts`、`upcoming-actions-tool.ts`）、静态 `AI_SYSTEM_PROMPT`。
- **W34（`cec3396`）**：`20261127010000_tob_r2_ai_message_plan_draft` 迁移、`draft-plan-tool.ts`、`CreatePlanDto.agentRunId` & `plan.service.ts` 审计关联、`ai.controller.ts` SSE `draft` 帧与消息落库、OpenAPI `generate:api` 同步、`ChatWorkspace`、`PlanDraftCard`、`/plans/new` 草稿确认与 `caps` 实时重检。
- **W35（`320181e`）**：`agent-tools.spec.ts` (10)、`agent-tool-authorization.spec.ts` (5)、扩展 `ai-chat.spec.ts` / `prisma.spec.ts`、`E2eFakeAgentChatModel` + `llm-factory.spec.ts` (8)、`run-e2e-tests.sh` 限流放大、`e2e/modules/16-agent-organization.spec.ts` (5 条 GWT)。
- **D6 审查修复（`f4a8921`）**：修复跨组织切页时 `/plans/new` URL 草稿参数与 `agentRunId` 泄漏风险（`sourceOrgId` 绑定），并补齐 post-loop abort 检查与 `chat-workspace` 错误态分支。
- **W36**：更新 `验收记录.md`、`需求文档.md`、`技术方案.md`、`docs/FEATURE-MAP.md`、`README.md`、`.changeset/tob-r2-agent.md` 及两份交接文档，推分支并建 Draft PR → `dev`。
