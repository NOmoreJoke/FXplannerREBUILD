# Goal #2 — FXplannerREBUILD · MVP-F1/F2 性能收敛、契约清零与 ToB R1 前置门

> 适用阶段：Phase 2（MVP-F1 请求与查询收敛 + MVP-F2 契约与结构收敛）
> 前置门控：**必须在 Goal #1（MVP-F0 正确性硬门）全部合入 `dev` 后启动**
> 依据决策：`docs/ITERATION-REFACTOR-ROADMAP-20261119.md`（D1–D9）、`docs/VIBE-CODING-PLAYBOOK.md`、`changes/tob-agent-workspace/技术方案.md` §11 & §15.1

---

## 1. 背景与唯一上下文（开工必先只读核验）
- 仓库：`/Users/kyle/Documents/工作/知爻/FXplannerREBUILD`
- 前置校验（**开工第一步**）：
  1. 检查 `git status -s`、`git fetch origin` 与 `dev` 分支是否已合入 Goal #1（验证 `packages/money` 含 `fast-check`、跨源汇率方向统一、`USAGE` 更正放开且 `T-CORR-004` 非 skip）；
  2. 若 Goal #1 尚未合入 `dev`，**立即停机汇报人类**，禁止在 F0 未闭环时叠加性能优化与结构重构；
  3. 确认基线干净后，从 `dev` 切出新特性分支：`feat/mvp-f1-f2-perf-contract`。
- 必读文件：
  - `AGENTS.md`
  - `docs/VERIFY.md`
  - `docs/ITERATION-REFACTOR-ROADMAP-20261119.md`
  - `changes/tob-agent-workspace/技术方案.md` §1.1、§9.3、§10.3、§11（DEBT-03~08）、§15.1（MVP-F1/F2）

## 2. 分支、自治与安全红线（违反即失败）
- **Git 自治边界（D7）**：允许在特性分支 `feat/mvp-f1-f2-perf-contract` 内自主小步 commit、安装方案写明的工具/lint 依赖、push 特性分支到远端并创建 **draft PR**（目标 `dev`）。
- **严禁操作**：禁止 merge 到 `dev`/`main`、禁止将 draft PR 转为 ready、禁止直接 push 到 `dev`/`main`、禁止执行生产部署或改服务器配置。
- **服务禁令**：由人类启动前后端服务。AI 确认服务就绪后直接运行 Playwright，取证后清理 `e2e/test-results`。`e2e/scripts/run-e2e-tests.sh` 会自行起服，留给人类执行。
- **3 轮自愈熔断 & Flaky 零容忍**：连续 3 轮同报错失败立即停机；严禁删断言、加 `sleep`、改大 timeout 或加 `skip`。
- **不扩大范围**：不得在本 Goal 中提前编写 ToB `Organization`/`Membership` 业务表迁移（ToB R1 留在 Goal #3 单独推进），但要为多租户注入 `organizationId` 做好 Query Key 与无影子类型底座。

---

## 3. 必做任务清单（5 个垂直切片 + ToB R1 前置门核对）

### 切片 1（F1-1 / DEBT-04）：最新汇率常数行查询
1. 改造 `services/chat/src/rate/rate.service.ts:461-476` 的 `findLatestRows(base, quotes)`：
   - 将当前「拉取该 `base + quotes` 全部历史行后再内存去重」改为数据库端每个 `quote` 取最新 `observedAt` 单行（PostgreSQL `DISTINCT ON (quote)` 或经 `EXPLAIN ANALYZE` 证实走 `(base, quote, observedAt)` 索引的等价写法）；
   - 保持同 `observedAt`、新鲜度窗口（`createdAt + 5min`）与 `sellRate` 映射语义 100% 不变。
2. **验收证据**：新增单测/集成测试构造多条历史数据，断言单次查询返回行数 ≤ `quotes.length`；在交接文档记录 `EXPLAIN ANALYZE` 实测结果。

### 切片 2（F1-2 / DEBT-03）：DataRequestLockGuard 查询合并与身份复用
1. 重构 `services/chat/src/data-request/data-request-lock.guard.ts:68-118` 与 `services/chat/src/data-request/data-request.service.ts`：
   - 合并「到期候选推进查询」与「活动锁判定查询」，使无活动请求的普通请求至多执行 **1 条 `data_requests` 查询**（而非当前固定 2 条），仅确有到期记录才进入清理重查；
   - 调整认证身份复用顺序，同时**严格保留**：无/无效 token 由 `JwtAuthGuard` 统一返回 401、`@SkipDataRequestLock` 白名单端点依然推进到期请求、三态锁行为不变。
2. **验收证据**：补齐全锁矩阵与白名单推进测试，并在交接文档列出优化前后 Prisma query log `data_requests` SQL 次数对比。

### 切片 3（F1-3 / DEBT-06）：前端查询降噪、集中缓存 Key 与业务 4xx 分级
1. 为 `clients/chat-web/app/(protected)/layout.tsx:157` 的 `<ReminderBell />` 及 reminders / settings hooks 增加「已完成建账且非数据锁定态」的 `enabled` 门控，消除未建账状态下必然触发的 409 请求。
2. 在 `clients/chat-web/lib/api/` 抽取集中式 React Query Key 工厂与失效辅助函数（统一管理 `home`、`accounts`、`plans`、`reminders`、`settings`、`reports` 的 key，便于 ToB R1 注入 `organizationId`）。
3. 在 `clients/chat-web/lib/api/client.ts` 将预期业务 4xx（如可恢复校验/未建账状态）与系统 5xx/网络异常的 dev-log 上报分级，消除误报噪声，同时保持 401/权限/锁定统一处理与 SSE 非 2xx 同语义。
4. **验收测试**：更新并跑通 `clients/chat-web/lib/hooks/*.spec.ts(x)`；验证未建账场景下零预期外 409 提醒/设置请求。

### 切片 4（F2-1 / DEBT-05）：清零全部前端手写影子 DTO
1. 检查并补齐缺失的后端 Swagger DTO 注解，运行 `bun run --cwd clients/chat-web generate:api`。
2. 彻底清除 `clients/chat-web/lib/api/contract.ts:92-150`（Plan 排期预览与创建手写类型）与 `clients/chat-web/lib/api/accounts.ts:14-68`（Account 列表/详情/流水手写类型）中的影子类型，全部改为 `Schemas["..."]` 别名。
3. 核查全仓 `clients/chat-web/lib/api/` 是否仍存在手写后端契约类型，确保唯一事实来源在后端 DTO。

### 切片 5（F2-2 / DEBT-08 + ESLint `observe`）：工具链、依赖减负与 Schema Relation 盘点
1. **接入 ESLint（D4：`observe` 模式）**：
   - 将 `packages/eslint-config` 接入 `services/chat/package.json:12` 与 `clients/chat-web/package.json:10` 的 `lint` 脚本（不再仅跑 `tsc --noEmit`）；
   - 按 `docs/VERIFY.md` §3 三态演进策略，对存量全仓警告先开 **`observe` 模式**（打印并统计存量基线而不误杀与本 Goal 无关的旧代码），对本次新建与修改文件强制 0 warning/error，确保后续可平滑切换至 `enforce`。
2. **清理确认零引用模板依赖**：
   - 核验后移除以下经 grep 实测全仓引用为 0 的包：`ali-oss`、`@types/ali-oss`、`sharp`、`fabric`、`@gsap/react`、`react-zoom-pan-pinch`、`@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`；
   - 运行 `bun install` 刷新 `bun.lock`，并验证 `turbo run build` 与 `infra/compose/Dockerfile.chat` / `Dockerfile.web` 构建上下文无断链。
3. **`WorkflowCheckpoint` 与 Prisma Relation 盘点**：
   - `services/chat/prisma/schema.prisma:84-94` 的 `WorkflowCheckpoint` 全仓业务引用为 0，但本次**先做代码与历史迁移盘点并保留（不贸然删表）**，在交接文档给出是否于 ToB 阶段清理的证据建议；
   - 盘点 `schema.prisma` 与数据库已有手工 FK：注意 **`plan_change_logs` 已有数据库 FK，严禁重复添加导致迁移报错**；`CostLot.sourceId` 与 `Correction.targetId` 属多态键保持现状不强拆；若补齐缺失显式 Prisma relation，必须先查孤儿数据并在本地测试库备份副本完成迁移与数据核对演练。

---

## 4. 验证门禁与独立对抗审

按 `docs/VERIFY.md` 执行：
1. **Diff 触发检查**：`git diff --name-only origin/dev...HEAD`，核对 DTO/OpenAPI、Prisma/数据修正、测试夹具命中项。
2. **L1 静态与单元/属性测试**：
   - `bun run typecheck`
   - `bun run lint`（记录 ESLint `observe` 模式统计基线，确认本批改动文件 0 新增告警）
   - `bun run test unit web scripts money dev-log`
3. **L2 接口与集成测试**（`bun run db:status` 确认后）：
   - `bun run test api integration infra`
4. **L3 E2E 全量回归**（确认人类已启动服务）：
   - `bun run test:e2e`（确认全量通过且无未建账 409/403 回归）
   - 取证后清理 `rm -rf e2e/test-results`
5. **异构独立对抗审（D6）**：
   - 优先 Codex CLI，不可用降级为 Antigravity 独立只读审查 Agent 并在交接披露；
   - 强制三态标签 `[Important]` / `[Nit]` / `[Pre-existing]`；全部 `[Important]` 必须清零并重跑受影响测试。

## 5. 提交、交接与 ToB R1（Goal #3）前置门输出
- 按切片做 Conventional Commits（尾部附 `Verified:` 戳记）+ `.changeset/*.md`。
- push `feat/mvp-f1-f2-perf-contract` 并创建 **draft PR** → `dev`（严禁 merge / ready）。
- 生成 `docs/handoff/OVERNIGHT-MVP-F1-F2-YYYYMMDD.md`，必须包含：
  1. 分支名、draft PR 链接、Commit 清单与切片 1–5 改动明细；
  2. `findLatestRows` `EXPLAIN ANALYZE` 证据、`DataRequestLockGuard` SQL 次数前后对比、ESLint `observe` 基线统计；
  3. L1/L2/L3 实跑日志与对抗审闭环清单；
  4. **ToB R1（Goal #3）启动前置核对门**：对照 `changes/tob-agent-workspace/技术方案.md` §15.1–§15.2，确认 P0 契约与 F0/F1/F2 硬门是否已全部满足、可否基于此启动 P1–P6。
