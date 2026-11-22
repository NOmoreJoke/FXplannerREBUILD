# Goal #2 验收交接报告 — MVP-F1/F2 性能收敛、契约清零与 ToB R1 前置门（2026-11-22）

> 分支：`feat/mvp-f1-f2-perf-contract`（基于本地 `dev` `52537c5` 切出）  
> 基线说明：本地 `dev`（`52537c5`）领先 `origin/dev`（`dd3d4c1`）5 个提交（`c6394b9..52537c5`）；**人工合入/在 GitHub 对比本 Draft PR 前，需先同步推送本地 `dev` 至 `origin/dev`**，否则 GitHub Diff 会包含这 5 个本地前置提交。  
> 参考基线：`docs/handoff/GOAL-2-MVP-F1-F2-REFACTOR-20261119.md`、`changes/tob-agent-workspace/技术方案.md` §15.1–§15.2、`docs/ITERATION-REFACTOR-ROADMAP-20261119.md`（D1–D9）、`docs/VERIFY.md`。

---

## 1. 提交清单（按垂直切片顺序）

| 切片 | Commit | 说明 | 提交戳记 |
| --- | --- | --- | --- |
| W8（F1-1 / DEBT-04） | `2aa75a8` | `findLatestPublishableQuotes` 常量行 LATERAL SQL 索引查询与边界单测/PG 回归 | `Verified: unit, api` |
| W9（F1-2 / DEBT-03） | `a639d92` | `RequestAuthService` WeakMap 请求级复用与 `DataRequestLockGuard` 单次 `findMany` 合并 | `Verified: unit, api, integration` |
| W10（F1-3 / DEBT-06） | `dbc6b6b` | 14 域集中 `queryKeys` 工厂、`useReminders`/`useReminderGate` 门控与 409/403 遥测降噪 | `Verified: unit` |
| W11（F2-1 / DEBT-05） | `2a0e10a` | 补齐后端 Swagger DTO/响应注解并清零前端全部手写 REST 影子 DTO | `Verified: unit, api` |
| W12（F2-2 / DEBT-08） | `2ccdd5c` | ESLint 9 Flat Config + `scripts/lint-observe.ts`、删除 9 个零引用依赖、`PlanChangeLog` 对齐、`cleanupUser` 事务化与孤儿清理 | `Verified: unit, api, integration, diff` |
| 对抗审修复 | `7593ffd` | 修复 R1 两项 `[Important]`（锁守卫 fail-closed、`lint-observe` 无基线 fail-closed + CI `fetch-depth: 0`）与三项 `[Nit]` | `Verified: unit, api, diff` |
| 交接与变更记录 | 本提交 | `.changeset/mvp-f1-f2-perf-contract.md` + 本验收交接文档 | `Verified: unit, api, integration, diff` |

---

## 2. 分切片验证与实测证据

### 2.1 W8（DEBT-04）：最新汇率常数行 LATERAL 查询

- **改动位置**：`services/chat/src/rate/rate.service.ts:611-699`、`services/chat/src/rate/rate.service.spec.ts`、`services/chat/test/api/rate.spec.ts:1327-1556`。
- **查询结构**：空 `quotes` 直接 0 SQL 短路，输入去重后以 `unnest($1::text[]) CROSS JOIN LATERAL`，分支 1（`latest_confirmed_at IS NOT NULL ORDER BY observed_at DESC LIMIT 1`）`UNION ALL` 分支 2（`latest_confirmed_at IS NULL ORDER BY observed_at DESC LIMIT 1`）外层 `LIMIT 1` 短路，保留 `NATIVE_DIRECTION_SOURCES = ['abc', 'identity']`、`canonical_write_id` / `migration_owner_id`、`rate >= 0.000000005`、`sell_rate IS NULL OR sell_rate >= 0.000000005` 全条件。
- **`psql` 实测 `EXPLAIN (ANALYZE, BUFFERS)`**（1,095 行 = 365 天 × 3 币对，`ANALYZE exchange_rates` 后回滚事务内执行）：
  - 总耗时：`Execution Time: 0.056 ms`；共享缓冲：`Buffers: shared hit=14`；
  - 执行计划：分支 1 命中 `Index Scan Backward using exchange_rates_base_quote_observed_at_idx (actual rows=1 loops=3)`，外层 `LIMIT 1` 触发分支 2 `(never executed)`，无 `Seq Scan`、`Sort` 或 `Incremental Sort`；
  - CI/API 回归测试 `services/chat/test/api/rate.spec.ts:1543-1547` 在 `SET LOCAL enable_seqscan = off` 下严格断言 `Index Scan Backward using exchange_rates_base_quote_observed_at_`、禁用 `Sort` / `Incremental Sort` 且含 `never executed`。

### 2.2 W9（DEBT-03）：身份缓存复用与单次 `data_requests` 查询合并

- **改动位置**：`services/chat/src/auth/request-auth.service.ts`、`services/chat/src/auth/auth.module.ts`、`services/chat/src/auth/guards/jwt-auth.guard.ts`、`services/chat/src/data-request/data-request-lock.guard.ts`、`services/chat/src/data-request/data-request.service.ts:344-410`。
- **查询计数与安全边界**（`services/chat/test/api/data-request.spec.ts:589-693` 实测）：
  - 优化前：单次受保护业务请求固定执行 2 次 JWT 验签（`DataRequestLockGuard` + `JwtStrategy`）、`advanceDueRequests` + 锁判定共 2 次 `data_requests` 查询，以及额外 `user.findUnique`。
  - 优化后：单次正常受保护请求严格 **`jwtService.verify = 1`、`user.findUnique = 1`、`dataRequest.findMany = 1`、`dataRequest.findFirst = 0`**；
  - `CLEAR PENDING` 期间：`GET /api/settings`（200）与 `POST /api/transactions`（403 `DATA_REQUEST_LOCKED`）均严格仅 `findMany = 1`、`findFirst = 0`；
  - 无效/幽灵 token（用户不存在）：在 `DataRequestLockGuard` 阶段 `dataRequest.findMany = 0`，由 `JwtAuthGuard` 统一返回 `401`；
  - 到期 `DELETION` 物理删除 `User` 后立即调用 `invalidateRequestUser(request)` 清空缓存并标记失效，保证同次请求 `JwtAuthGuard` 返回 `401`；
  - 对抗审 R1 加固（`7593ffd`）：非白名单受保护端点在 `prisma.dataRequest.findMany` 异常时强制 **fail-closed（HTTP 500）**，仅 `@SkipDataRequestLock` 白名单端点保留日志告警后放行（HTTP 200）。

### 2.3 W10（DEBT-06）：前端 `queryKeys` 工厂、建账/锁定门控与遥测降噪

- **改动位置**：`clients/chat-web/lib/api/query-keys.ts`、`clients/chat-web/lib/api/client.ts`、`clients/chat-web/lib/api/chat.ts`、`clients/chat-web/lib/hooks/use-reminders.ts` 及全仓调用方（14 个领域 45 个修改/新增文件）。
- **核心成果**：
  - 集中管理 14 个域 Query Key，内置 `withOrgScope(orgId, key)` 为 ToB R1 组织缓存隔离就绪，提供 `invalidateAfterOnboarding`、`invalidateAfterLedgerMutation`、`invalidateAfterDataRequestMutation` 失效助手；
  - 全部组件/页面/hook 清理完毕，未留业务手写 `queryKey: [...]` 散落字面量；
  - `isExpectedControlFlowApiError` 对 `409 ONBOARDING_NOT_COMPLETED` 与 `403 DATA_REQUEST_LOCKED | ACCOUNT_PENDING_DELETION` 静默 dev-log 上报（保留正常 4xx/5xx 上报与 401/403 跳转契约）；
  - `useReminderGate` 在 `/onboarding`、`/data-requests`、未完成建账或 `reminderEnabled === false` 时阻断预期外 409 `/settings` 与 `/reminders` 轮询。

### 2.4 W11（DEBT-05）：OpenAPI 补全与影子 DTO 清零

- **改动位置**：`services/chat/src/account/dto/account.dto.ts`、`services/chat/src/plan/dto/plan.dto.ts`、`services/chat/src/plan/plan.controller.ts`、`services/chat/src/ai/dto/ai.dto.ts`、`services/chat/src/ai/ai.controller.ts`、`clients/chat-web/lib/api/{openapi.json,schema.gen.ts,contract.ts,accounts.ts,data-requests.ts,chat.ts}`。
- **契约一致性**：
  - `SchedulePreviewDto.pacePreference` 仅在 `@ApiProperty` 增加 `enum: [...PACE_PREFERENCES]`，不加 `@IsIn`，保留 `PlanService` 既定 `400 INVALID_PLAN_PARAMS` 错误码；
  - `bun run --cwd clients/chat-web generate:api` 双跑幂等校验（SHA-256 两次完全一致：`openapi.json` `547c2b78871244aacb1ccf745b6f5e61cf4490020f164ebe2d4f9c8726f03628`，`schema.gen.ts` `56c8e6bf20b95bc6f6915a698bb8d0ca8b7a827e375d98451f6fc5ebf58d4897`）；
  - 全仓审计 `clients/chat-web/lib/api/`：全部 REST DTO 与响应/请求体均改为 `components["schemas"]` 别名；仅非 OpenAPI 的 SSE 帧协议类型（`chat.ts`）、静态 UI 字典项 `CurrencyOption`（`currencies.ts`）与客户端筛选参数包 `ReportListFilters`（`reports.ts`）保留本地接口。

### 2.5 W12（DEBT-08 + ESLint `observe`）：工具链、依赖清理与 Schema 对齐

- **ESLint 9 Flat Config 与 `lint-observe`**：
  - 升级 `packages/eslint-config/{base.js,nestjs.js,nextjs.js,package.json,README.md}`（零新增依赖），新增 `services/chat/eslint.config.mjs`、`clients/chat-web/eslint.config.mjs`、`scripts/lint-observe.ts`、`scripts/__tests__/lint-observe.spec.ts`；根 `eslint.config.mjs` 与 `scripts/check-structure.ts` 原样保留并前置运行；
  - 全仓存量 `observe` 基线实测：`services/chat` 扫描 209 文件（存量 6 errors / 57 warnings；本分支 18 个变更文件通过）、`clients/chat-web` 扫描 222 文件（存量 2 errors / 17 warnings；本分支 44 个变更文件通过）；
  - 双重负向反证：
    1. `--stdin` `services/chat/eslint.config.mjs` 对未使用变量报 `@typescript-eslint/no-unused-vars` 退出码 `1`；
    2. `--stdin` `clients/chat-web/eslint.config.mjs` 对条件调用 `useState()` 报 `react-hooks/rules-of-hooks` 退出码 `1`；
    3. `bun run scripts/lint-observe.ts --dir services/chat --base nonexistent-ref` 拦截无效基线，退出码 `1`；
    4. `.github/workflows/ci.yml` `lint-and-typecheck` Checkout 增加 `fetch-depth: 0` 防止 CI 浅克隆绕过。
- **9 个零引用依赖清理 + 生产构建验证**：
  - `services/chat/package.json` 移除 `ali-oss`、`@types/ali-oss`、`sharp`；
  - `clients/chat-web/package.json` 移除 `@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`、`@gsap/react`、`fabric`、`react-zoom-pan-pinch`；
  - `bun install` 更新 `bun.lock`，`turbo run build`（NestJS + Next.js 16.2.3）完整通过。
- **Schema Relation（方案 2A）与全仓外键 / `WorkflowCheckpoint` 盘点**：
  - `PlanChangeLog.plan`（`services/chat/prisma/schema.prisma:259,306`）显式声明 `@relation(fields: [planId], references: [id], onDelete: Cascade)`，与既有迁移 `plan_change_logs_plan_id_fkey` 完全一致，`prisma migrate diff` 实测输出 `-- This is an empty migration.`（零 DDL 变更）；
  - 修复 `services/chat/test/helpers/test-app.ts:82-120` `cleanupUser`（在事务内先删 `UsageLotAllocation` 与 `PlanAllocation` 再删 `User`）；
  - 清理本地库 `fxplanner_new_db_local` 历史遗留孤儿行前后实测：
    - `plan_allocations`（无对应 `plans`）：**`1371 -> 0`**
    - `usage_lot_allocations`（无对应 `usage_records` / `cost_lots`）：**`1707 -> 0`**
    - 全量 L2（`api` + `integration` + `infra`）跑完后复查：**仍为 `0` / `0` / `0`**。

| 表 / 字段 | Schema 状态 | 处置结论 | 实测现状 / 依据 |
| --- | --- | --- | --- |
| `WorkflowCheckpoint`（`workflow_checkpoints`） | 保留表与 model，未增减列 | **保留不动** | 业务源码零引用（仅 `test/prisma.spec.ts:26,183`），本地库 `0` 行；待 ToB P7/P8 Agent 多步恢复阶段决策去留 |
| `PlanChangeLog.planId` | 已补齐 `@relation` + `Plan.changeLogs` | **本批已对齐** | 零 DDL 变更；本地库 `107` 行均有效 |
| `PlanAllocation.planId` | `@unique` 裸外键 | **保留裸外键，补齐测试清理** | 生产注销路径已显式清理；测试 `cleanupUser` 已补全事务清理，孤儿已清零 |
| `UsageLotAllocation.usageId` / `lotId` | 复合索引裸外键 | **保留裸外键，补齐测试清理** | 同上；孤儿已清零且全量测试后不复发 |
| `CostLot.sourceId` | 多态来源 ID（`PURCHASE` / `INITIAL`） | **不强拆多态关系** | 按 §15.1 F2 约束保留原样 |
| `Correction.targetId` | 多态目标 ID（`TRANSACTION` / `USAGE` 等） | **不强拆多态关系** | 按 §15.1 F2 约束保留原样 |
| `Transaction.planId` / `Reminder.planId` | 可空弱关联历史/提醒 | **保留不动** | 按设计允许独立生命周期或后续按需清理 |

---

## 3. 全量验证矩阵（最终提交 `7593ffd` 之后实测）

| 级别 | 检查项 / 套件 | 结果 | 详情 / 备注 |
| --- | --- | --- | --- |
| L1 | `bun run typecheck` | ✅ PASS | 4/4 包通过（含 `rate-cache-migration/tsconfig.json`） |
| L1 | `bun run lint` | ✅ PASS | `lint:eslint` + `check:structure` + `lint:observe`（全过） |
| L1 | `unit`（后端单元） | ✅ PASS | 36 文件，540 passed \| 1 todo（541） |
| L1 | `web`（前端单元，Node 24） | ✅ PASS | 27 文件，247 passed |
| L1 | `money`（精度/属性测试） | ✅ PASS | 4 文件，64 passed |
| L1 | `dev-log`（开发日志服务） | ✅ PASS | 4 文件，25 passed |
| L1 | `scripts`（工具链单测） | ✅ PASS | 1 文件，7 passed（26 assertions） |
| L1 | `migrate.spec.ts` | ✅ PASS | 1 文件，18 passed |
| L2 | `bun run db:status` | ✅ PASS | PostgreSQL 5432 在线 |
| L2 | `api`（后端接口） | ✅ PASS | 18 文件，318 passed |
| L2 | `integration`（后端集成） | ✅ PASS | 14 文件，81 passed |
| L2 | `infra`（`test/prisma.spec.ts`） | ✅ PASS | 1 文件，13 passed |
| L2 | `bun run build`（Node 24） | ✅ PASS | NestJS + Next.js 16.2.3（18 条路由）生产构建通过 |
| L2 | 测后本地库孤儿行复查 | ✅ PASS | `plan_allocations=0`、`usage_lot_allocations=0` |
| **合计** | **L1 + L2 全部自动化测试** | **✅ 0 failed** | **106 文件，1,313 passed（+ 1 既有 todo）** |
| L3 | `4001/api/health` & `3001` 只读探活 | `NOT_RUN` | 按 `AGENTS.md` AI 禁启服务红线未启动 dev/E2E；只读 curl 确认两端口离线（E2E 留待人类启服复跑） |

---

## 4. 独立对抗性审查闭环记录

- **执行方式说明**：优先尝试只读 Codex CLI（`codex exec -s read-only`，默认配置 `gpt-6.2-sol` 及显式 `-m gpt-5.5` 均返回 `400 model_not_found: The ... model is not supported when using Codex with a ChatGPT account`），按审批方案降级为独立只读 `research` 子智能体（会话 `2b332e4d-035e-47b7-81ce-f9eda9e36cda`），以 `git show dev:...` 不可变基线规则审查 `dev..HEAD`。
- **R1 审查结果（`2aa75a8..2ccdd5c`）**：`Verdict: 2 [Important], 7 [Nit], 3 [Pre-existing]`
  1. `[Important]` W9 `DataRequestLockGuard` 对 `prisma.dataRequest.findMany` 异常统一 swallow 导致非白名单端点 fail-open → **已在 `7593ffd` 修复**：仅 `skipLock === true` 保留 best-effort 放行，非白名单端点强制 rethrow fail-closed（500），并补齐 API 单测。
  2. `[Important]` W12 `scripts/lint-observe.ts` 缺省找不到 `dev`/`origin/dev` 时放行 0 个变更文件形成假绿 → **已在 `7593ffd` 修复**：显式 `--base` 失效或 CI（`CI` / `GITHUB_ACTIONS`）无基线时 fail-closed 退出 `1`，支持 `GITHUB_BASE_REF` 且 `.github/workflows/ci.yml` `lint-and-typecheck` Checkout 加 `fetch-depth: 0`。
  3. 同步收口 3 项低风险 `[Nit]`：`rate.spec.ts` 严格断言 `Index Scan Backward` 且禁用 `Sort`/`Incremental Sort`、`packages/eslint-config/base.js` 对齐根配置 `ban-ts-comment`、`cleanupUser` 读 ID 收进 `$transaction`。
- **R2 增量复核结果（`2ccdd5c..7593ffd`）**：`Verdict: 0 [Important], 0 [Nit], 0 [Pre-existing]`。
- **保留 Backlog 的非阻断 `[Nit]` / `[Pre-existing]` 项**（留待 Goal #3 / 日常清理）：
  - `query-keys.ts` 的 `invalidateAfter*` 函数接入 `orgId`（随 ToB R1 P2 改造一并传递）；
  - `client.spec.ts` 补齐 401 `clearToken()` 与非 `/data-requests` 路径 403 跳转测试、`isReminderBypassRoute` 边界段匹配；
  - `lint-observe.ts` 在切换为 `enforce` 模式前将已修改文件的容忍门槛收紧为增量 hunk 0-warning；
  - `DataRequestService.executeCleanup` 并发认领改为条件更新（`status IN ('PENDING', 'FAILED')`）；
  - `services/chat`（6 处）与 `clients/chat-web`（2 处）存量 `@typescript-eslint/no-unused-vars` 错误（均在本次 `observe` 基线中标出，未改动文件未触发阻断）。

---

## 5. ToB R1（§15.1–§15.2）前置门核对表

依据 `changes/tob-agent-workspace/技术方案.md` §15.1（P0 契约与行为基线准入条件）与 `docs/handoff/GOAL-2-MVP-F1-F2-REFACTOR-20261119.md`：

| 前置项 | 状态 | 依据 / 备注 |
| --- | --- | --- |
| MVP-F1 Guard 复用身份与单次锁查询（含 401/白名单语义） | ✅ 已达标 | `a639d92` + `7593ffd` |
| MVP-F1 最新汇率常数行索引查询 | ✅ 已达标 | `2aa75a8`（PG 0.056ms，Index Scan Backward） |
| MVP-F1 建账/锁定期请求门控、集中 `queryKeys`（`withOrgScope`）与 409/403 降噪 | ✅ 已达标 | `dbc6b6b` |
| MVP-F2 契约单一来源（后端 OpenAPI → `schema.gen.ts`，清零前端手写 REST 影子 DTO） | ✅ 已达标 | `2a0e10a` |
| MVP-F2 清理 9 个确认零引用依赖 + `lint-observe` 工具链 + `PlanChangeLog` relation | ✅ 已达标 | `2ccdd5c` + `7593ffd` |
| 未提前引入 ToB `Organization`/`Membership` 迁移 | ✅ 已遵守 | Prisma 无额外 DDL；ToB 留待 Goal #3 单独推进 |
| **前置伴随遗留项（非 Goal #2 范围，人类评估后推进 Goal #3）** | ⚠️ 需关注 | 1. Phase 1 交接 `docs/handoff/PHASE1-EXIT-STATUS-20261122.md` 记录的 L3 E2E **`T-AI-003`（追问流 `ERR_ABORTED`）尚未结案**，及本批次尚未实跑 L3 Playwright；<br>2. 既定延后技术债（`plan-allocations` 导出 CSV 精度、`TransactionService`/`OnboardingService` 的 `lockLedgerAccounts`、W12 保留 backlog `[Nit]`）未混入本批。 |

---

## 6. 建议人工下一步操作

1. 先将本地 `dev`（`52537c5`）推送至 `origin/dev`，使远端 PR 基线与当前分支起点一致。
2. 启动本地前后端后复跑全量 Playwright E2E，并专项闭合 `PHASE1-EXIT-STATUS-20261122.md` 中的 `T-AI-003`。
3. E2E 全绿且评审通过后，再将 Draft PR 转为 Ready 并合入 `dev`，随后启动 Goal #3（ToB R1 `Organization` / `Membership` 地基迁移）。
