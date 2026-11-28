# Goal #7 — Stage 1 账本修订触发器、Harness 提案闭环、知禾多子图与双模存折工作台（`W40–W44`）

> **接力序列**：`Goal #6`（`W37–W39`）→ `Goal #6.5`（PR #19 `c184613`）→ **`Goal #7 (W40 / W41 / W42 / W43 / W44)`** → `Goal #8 (Stage 2, W45–W48)`  
> **上游真源**：`AGENTS.md`、`docs/VERIFY.md`、`design-harness/README.md`、`changes/product-harness-agent/{需求文档.md,技术方案.md,agent-设计规格.md}`

---

## 1. 已锁定工程决策（`D-A1`–`D-A5` + 结构护栏）

1. **D-A1 正文输出时序**：采用「进度 `step` 与 `proposal` 实时流式 + 正文先经 `DeterministicRuleEngine` 全文过检后再按片吐 `token`」，100% 杜绝合规封杀词与编造裸数字短暂上屏。
2. **D-A2 用户记忆分期**：Stage 1 扎实落地 **L0**（单轮工作台上下文）+ **L1**（`OrganizationSettings`/`UserSettings` 结构化真源）+ **L2**（`ai_conversations` / `ai_messages.resolved_slots` 永久冻结快照 + 会话活跃提案锚点）；**L3** 跨会话软偏好表 `ai_user_memories` 放 Stage 2 独立增强。
3. **D-A3 历史槽位续聊防误用**：组装历史上下文时给附带 `resolved_slots` 的旧助手消息注入 `[历史冻结快照 @时间，非当前实时值]` 注记，前端历史回看恒读落库冻结原值。
4. **D-A4 缺参澄清原则**：建/调计划缺少必填参数或存在多张活跃计划未指明目标时，仅温和反问澄清或列出候选计划，严禁猜默认日期出单。
5. **D-A5 合成超时保底**：工具已成功写入 `PENDING` 提案时，后续合成超时或二次拦截自动走 `factual-template.ts` 保底交付，不丢预演单。
6. **防坑红线**：
   - `AgentProposal` 关联 `User` / `AiConversation` / `AiMessage` 一律可空且 `onDelete: SetNull`（保障 `data-request-cleanup.ts` 个人注销零级联断言）；
   - `ledger_revisions` 单调不重置（`ORGANIZATION CLEAR` 严禁删行，只失效活跃提案；触发器写入前通过 `INNER JOIN organizations` 与升序排序防死锁及删组织 FK 报错）；
   - `AGENTS.md` 路径登记与对应代码/迁移必须在同一个 PR 完成（遵循 `W37` `I-1`）。

---

## 2. 五切片顺序推进与分支规划

- **`W40`（分支 `feat/stage1-w40-ledger-revision-proposals`）**：
  - 落盘本接力文档与定稿 `agent-设计规格.md`；
  - `schema.prisma` 新增 `LedgerRevision`、`AgentProposal`、`AiMessage.resolvedSlots`，迁移脚本创建 6+1 张账本表语句级触发器（`FOR EACH STATEMENT` + transition table）并幂等回填存量 `plan_draft` 为 `LEGACY`；
  - 适配 `data-request-cleanup.ts` 与 `test-app.ts`，补齐 `test/prisma.spec.ts` 触发器/清理/约束全量基础设施测试。
- **`W41`（分支 `feat/stage1-w41-proposal-module` · 基于 `W40` 合入后 `dev`）**：
  - `config/env.ts` 新增 `AGENT_PROPOSAL_TTL_HOURS=24`、`AGENT_PROPOSAL_ACTIVE_LIMIT=20`；`OrganizationCurrentDto` 新增 `memberCount`；
  - `PlanService` 抽取 `createInTx` / `adjustInTx` 保障单事务原子入账；
  - 新增 `services/chat/src/proposal/` 独立模块（8 态、原位微调只读重算、`409 PROPOSAL_STALE`、20 条上限拦截、同事务入账与 `AuditLog`）；
  - 同步更新 `scripts/check-org-scope.ts`、`eslint.config.mjs`、`AGENTS.md`，双跑 `generate:api` 校验 SHA-256 零漂移，新增 `test/api/proposal.spec.ts` 并扩展 `organization-matrix.spec.ts`。
- **`W42`（分支 `feat/stage1-w42-zhihe-langgraph` · 基于 `W41` 合入后 `dev`）**：
  - 新增 `services/chat/src/ai/agents/` LangGraph `StateGraph` 多子图编排（`PreDispatchPermissionGate` → `IntentRouter` → `market/ledger/plan/explainer` 4 专员 → `ZhiheSynthesizer` → `DeterministicRuleEngine` + `LocalFactualTemplate`）；
  - 扩展 SSE `step / proposal / verification / stage_signal`（向后兼容旧 `draft` 与 `[R2-E2E]`），落库 `resolved_slots`，新增 `slot-freeze.property.spec.ts` 与单/集成测。
- **`W43`（分支 `feat/stage1-w43-dual-mode-collab-ui` · 基于 `W42` 合入后 `dev`）**：
  - **动手编码前先做 1 轮轻量 `Steer / Concept` 确认**（顶栏双模翻转控件 + 多提案切换布局，沉淀至 `design-harness/intelligence/memories/`）；
  - 落地顶栏「账本 ⇄ 知禾协作（含待确认角标）」、URL 上下文驱动、`clients/chat-web/components/business/collab/` 全 11 态存折检视台、`useDebouncedProposalPreview`（零 `useEffect`/零 `setTimeout`/零原始色阶）、`Solo-First`（`memberCount === 1` 零企业词）与 `/plans` 轻入口。
- **`W44`（分支 `feat/stage1-w44-eval-e2e-closeout` · 基于 `W43` 合入后 `dev`）**：
  - 落地 ≥80 条中文路由/护栏评测集 `test/integration/zhihe-routing-eval.spec.ts`（路由准确率 ≥ 95%，越权/高危/注入/裸数字/漏放 = 0）；
  - 新增 `e2e/modules/17-collab-proposal-stage.spec.ts` 覆盖桌面 `1440px` + 移动 `390px` 双视口（0 横向溢出），刷新 `docs/FEATURE-MAP.md` 与收口验收报告。

---

## 3. 统一退出标准

1. **L1 全绿**：每个切片均须 `bun run lint`（0 errors, 0 warnings）+ `bunx turbo run typecheck --force` + `bun run test unit web scripts money dev-log` + `bunx turbo run build --force` 0 failed；新增门禁规则须附正/负双证。
2. **L2 全绿**：`W40` / `W41` / `W42` / `W44` 均须跑通 `bun run test infra api integration`、`organization-matrix.spec.ts` 与评测门禁。
3. **L3 全绿**：`W43` / `W44` 在人类启服后跑通 `14-ai-chat`、`16-agent-organization`、`17-collab-proposal-stage` 并清理 `e2e/test-results`。
4. **独立审查与工作流纪律**：每个切片独立隔离 worktree + 独立只读复核（`[Important] = 0`）+ Draft PR → `dev`（AI 严禁自行启服或自合并）。
