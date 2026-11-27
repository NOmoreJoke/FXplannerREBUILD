# Goal #4 Overnight Handoff：ToB R2 可控组织 Agent（P7–P8 / W33–W36）

- **目标文档**：[GOAL-4-TOB-R2-AGENT-20261127.md](./GOAL-4-TOB-R2-AGENT-20261127.md)
- **分支与基准**：`feat/tob-r2-agent`（自隔离 worktree `/Users/kyle/Documents/工作/知爻/Worktrees/tob-r2-agent` 切自 `dev` `64fc154` / PR #12）→ **Draft PR → `dev`**（严禁自合并或标 Ready）

---

## 1. Commit 清单

| 切片 | Commit SHA | 说明 | 核心交付 |
| --- | --- | --- | --- |
| W33 | `2c6f340` | `feat(ai): add R2 org read-only tools, real-time tool guard, and kill switch` | `tool-guard.ts`、4 个只读组织工具（账户/敞口/成本/待办）、`rate-tool.ts` `.strict()` + guard、`AI_ORG_TOOLS_ENABLED` 开关、`AI_SYSTEM_PROMPT` 防注入边界 |
| W34 | `cec3396` | `feat(ai,plan,web): add draft_fx_plan tool, planDraft persistence, and confirmation UI` | `draft_fx_plan` 只读预览工具、`ai_messages.plan_draft` JSONB 迁移（`20261127010000_tob_r2_ai_message_plan_draft`）、SSE `draft` 帧、`CreatePlanDto.agentRunId` 审计串联、OpenAPI 同步、`ChatWorkspace` + `PlanDraftCard` + `/plans/new` 草稿确认闭环 |
| W35 | `320181e` | `test(tob-r2): add agent tool unit/integration tests, E2E fake ReAct, and 16-agent E2E` | `agent-tools.spec.ts` (10)、`agent-tool-authorization.spec.ts` (5)、扩充 `ai-chat.spec.ts` / `prisma.spec.ts`、`E2eFakeAgentChatModel` + `llm-factory.spec.ts` (8)、`run-e2e-tests.sh` 注入 `AI_SEND_THROTTLE_LIMIT=200`、`e2e/modules/16-agent-organization.spec.ts` (5 条 GWT) |
| D6 修复 | `f4a8921` | `fix(web,ai): scope plan draft URL to sourceOrgId and guard post-loop abort` | 修复 D6 对抗审发现的 `[Important]`（`PlanDraftCard` + `parsePlanDraftQuery` 强制校验 `sourceOrgId === activeOrgId`，防切组织带入旧组织草稿与 `agentRunId`），补齐 `ai-agent.service.ts` post-loop abort 校验与 `chat-workspace` 错误态显示 |
| W36 | （随本文件提交） | `docs(tob-r2): add R2 acceptance record, feature map updates, and Goal #4 handoff` | 更新 `验收记录.md`、`需求文档.md`、`技术方案.md`、`FEATURE-MAP.md`、`README.md`、`.changeset/tob-r2-agent.md`、本文档与 `GOAL-4-TOB-R2-AGENT-20261127.md` |

---

## 2. 数据库迁移与备份凭证

- **操作前逻辑备份**：`/tmp/fxplanner_new_db_local_pre_goal4.sql`（3.5 MB，`fxplanner_new_db_local`）。
- **新增迁移**：`services/chat/prisma/migrations/20261127010000_tob_r2_ai_message_plan_draft/migration.sql`（纯增量可空列：`ALTER TABLE "ai_messages" ADD COLUMN "plan_draft" JSONB;`）。
- **验证**：`prisma migrate status` 输出 `Database schema is up to date!`，`prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code` 退出 `0`（`No difference detected.`）。

---

## 3. Final Gate 实测结果

- **裁判基线**：`git diff dev -- eslint.config.mjs docs/VERIFY.md scripts/check-structure.ts` = **空**（0 改动）。
- **L1 静态与构建**（`f4a8921` 后实跑）：
  - `check:structure` exit 0；
  - `check:org-scope` exit 0（扫描 `68` 文件，`0` 违规）；
  - `lint` exit 0（ESLint `0` errors；`lint:observe` 0 errors）；
  - `typecheck` exit 0（Turbo 4/4）；
  - `generate:api` 两次 SHA-256 零漂移（`openapi.json` `9d4ac63c...`，`schema.gen.ts` `95098857...`）；
  - `build` exit 0（NestJS 后端 + Next.js 16.2.3 Turbopack 21 路由）。
- **L1+ & L2 测试矩阵**：
  - `unit`（`f4a8921` 后）：51 文件 / **`751 passed | 1 todo (752)`**
  - `web`（`f4a8921` 后）：36 文件 / **`439 passed`**
  - `ai-chat.spec.ts`（`f4a8921` 后）：1 文件 / **`34 passed`**
  - `money`：4 文件 / **`64 passed`**
  - `dev-log`：4 文件 / **`31 passed`**
  - `scripts`：3 文件 / **`24 pass, 0 fail`**
  - `api`（W35 全套）：22 文件 / **`851 passed`**
  - `integration`（W35 全套）：19 文件 / **`152 passed`**
  - `infra`（W35 全套）：1 文件 / **`27 passed`**
- **L3 Playwright E2E 清单验证**：
  - 严格遵守 `AGENTS.md` 禁止 AI 自行启服规则；`bunx playwright test --list` 校验全仓 **21 文件 / 112 条用例**全部可解析，新增 `e2e/modules/16-agent-organization.spec.ts` 覆盖 `GWT-19..25`、`GWT-13`（Agent 侧）、`GWT-29`。

---

## 4. 人类启服后 E2E 复跑指令

```bash
# 全量 E2E（含 14-ai-chat 与 16-agent-organization，run-e2e-tests.sh 已自动注入 AI_E2E_FAKE_STREAM=true 与 AI_SEND_THROTTLE_LIMIT=200）
./e2e/scripts/run-e2e-tests.sh --headless

# 或启服后单独执行 ToB R2 Agent E2E：
# bun run test:e2e -- e2e/modules/16-agent-organization.spec.ts
rm -rf e2e/test-results
```

---

## 5. 发布检查签字项

- [x] `W33` 4 个组织只读工具 + 实时 `tool-guard` + `AI_ORG_TOOLS_ENABLED` 独立降级开关全部交付并单测/集成验证
- [x] `W34` `draft_fx_plan` 只读预览 + `planDraft` 落库与 SSE `draft` 帧 + `/plans/new` 实时 `caps` 重检 + `agentRunId` 审计串联交付
- [x] `W35` 单元/接口/集成/基建/Playwright E2E（含 `E2eFakeAgentChatModel`）补齐，L1/L1+/L2 全绿
- [x] `D6` 独立对抗审 1 项 `[Important]` 修复并复核归零
- [ ] **人类待签字项**：合入 PR #12 后按需拉起本地前后端实跑 `./e2e/scripts/run-e2e-tests.sh --headless` 验证 `16-agent-organization.spec.ts` 5/5 通过并审阅合入 Draft PR。
