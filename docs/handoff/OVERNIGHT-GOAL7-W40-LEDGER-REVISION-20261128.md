# Goal #7 (`W40`) Overnight Handoff：Stage 1 账本修订触发器、AgentProposal 8 态表与规格定稿

- **目标文档**：[GOAL-7-STAGE1-HARNESS-PROPOSAL-ZHIHE-20261128.md](./GOAL-7-STAGE1-HARNESS-PROPOSAL-ZHIHE-20261128.md)
- **分支与隔离 Worktree**：`feat/stage1-w40-ledger-revision-proposals`（`/Users/kyle/Documents/工作/知爻/Worktrees/stage1-w40-ledger-revision-proposals`，切自 `origin/dev@c184613`）→ **Draft PR → `dev`**

---

## 1. 交付内容

1. **Agent 工程设计规格定稿与 Goal #7 接力文档**：
   - `changes/product-harness-agent/agent-设计规格.md`：锁定 `D-A1–D-A5` 全部 5 项核心决策（进度实时流式 + 正文先检后吐、Stage 1 落地 L0+L1+L2、历史槽位续聊加注 `[历史冻结快照]`、缺参反问不猜默认日期、已产出提案遇合成超时走 `factual-template.ts` 保底），并完整定义 LangGraph `StateGraph` 拓扑、五层上下文、工具鉴权与 9 级降级矩阵。
   - `changes/product-harness-agent/技术方案.md`：补充关联 `agent-设计规格.md`。
   - `docs/handoff/GOAL-7-STAGE1-HARNESS-PROPOSAL-ZHIHE-20261128.md`：固化 `W40–W44` 五切片接力路线、防坑红线与退出门禁。
2. **Prisma Schema 与 PostgreSQL 迁移（`20261129090000_stage1_ledger_revisions_and_proposals`）**：
   - 新增 `ledger_revisions`（主键 `(organization_id, currency_code)`，`revision BIGINT DEFAULT 1`），并构建 6+1 张账本表（`accounts` / `transactions` / `initial_holdings` / `cost_lots` / `usage_records` / `plans` + `plan_allocations`）语句级触发器（`FOR EACH STATEMENT` + transition table），按 `(organization_id, currency_code)` 去重并升序 upsert；`UPDATE` 改币种同时递增新旧币种；`INNER JOIN organizations` 防止组织删除级联清理时触发外键报错。
   - 新增 `agent_proposals`（8 态 `CHECK`、5 类 `kind` `CHECK`、4 组索引）；关联 `users`（`created_by_id` / `confirmed_by_id`）、`ai_conversations`、`ai_messages` 全部可空且 `ON DELETE SET NULL`，满足个人注销零级联断言。
   - `ai_messages` 新增 `resolved_slots JSONB`；幂等回填存量 `ai_messages.plan_draft IS NOT NULL` 为 `status='LEGACY'` 只读提案。
   - 同步在 `AGENTS.md` 登记新迁移目录路径。
3. **数据清理与基础设施测试适配**：
   - `services/chat/src/data-request/data-request-cleanup.ts`：`ORGANIZATION CLEAR` 严格保留 `ledger_revisions` 单调不重置，并将活跃 `PENDING` / `STALE` 提案置为 `INVALIDATED`（`ORGANIZATION_CLEARED`，仅计数 `> 0` 时写入 `stats`）；`ORGANIZATION DELETION` 与孤儿组织回收显式清理 `agent_proposals`。
   - `services/chat/src/data-request/data-request.service.spec.ts`：`ON DELETE SET NULL` 外键目录断言同步纳入 `agent_proposals.created_by_id` 与 `confirmed_by_id`。
   - `services/chat/test/helpers/test-app.ts`：`deleteOrganizationsCascadeLedger` 按子→父顺序清理 `agentProposal` 与 `ledgerRevision`。
   - `services/chat/test/prisma.spec.ts`：新增 7 个测试覆盖 6+1 表触发器、原生 SQL、改币种、单语句多行批写去重、`CLEAR` 单调性、个人注销零级联与 `SET NULL`、组织删除清理、`CHECK` 约束与 `LEGACY` 幂等回填。

---

## 2. 独立审查与全套实测结果（0 failed）

- **独立只读对抗审查**（`research` subagent）：
  - 发现 1 项 `[Important]`（`invalidatedProposals: 0` 破坏 `data-request.service.spec.ts` 严格 `stats` 断言）→ 已在 `data-request-cleanup.ts` 改为仅 `> 0` 时写入；
  - 发现多项 `[Nit]` → 已修正 `agent-设计规格.md` 的 `PlanService.getDetail` 方法名、对齐 `GOAL-7` 文档 `INNER JOIN` 描述、更新 `test-app.ts` 顺序注释，并在 `prisma.spec.ts` 补充单语句多行批写去重与跨币种递增验证。
- **全量非缓存验证（最后一次代码改动后全套重跑，全部 Exit `0`）**：

| 检查项 | 命令 | 结果 |
| :--- | :--- | :--- |
| 静态护栏与 `--enforce` | `bun run lint` | 通过：`check:structure` ✅、`check:org-scope`（69 文件 0 违规）✅、`check:compliance-copy`（388 文件 0 违规）✅、`clients/chat-web` **0 errors, 0 warnings（273 文件）** ✅、`services/chat` **0 errors, 0 warnings（285 文件）** ✅ |
| 非缓存类型检查 | `bunx turbo run typecheck --force` | 通过：4/4 包 PASS（0 cached） |
| 后端单元测试 | `bun run test unit` | 通过：52 files，759 passed（1 既有 todo） |
| 前端单元测试 | `bun run test web` | 通过：45 files，464 passed |
| 精度纯函数与属性测试 | `bun run test money` | 通过：4 files，64 passed |
| 开发日志服务包 | `bun run test dev-log` | 通过：4 files，31 passed |
| 工程脚本门禁单测 | `bun run test scripts` | 通过：6 files，40 passed |
| 数据库基础设施与触发器 | `bun run test infra` | 通过：1 file，34 passed |
| 后端 API 接口测试 | `bun run test api` | 通过：22 files，851 passed |
| 后端集成测试 | `bun run test integration` | 通过：19 files，152 passed |
| 非缓存生产构建 | `bunx turbo run build --force` | 通过：`@fxplanner-new/chat` + `@fxplanner-new/chat-web`（21 路由）PASS（0 cached） |
