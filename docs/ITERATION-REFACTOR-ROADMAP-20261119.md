# FXplannerREBUILD 迭代与重构总方案（2026-11-19 定稿）

> 状态：已通过 `/grill-me` 对齐并锁定战略、门禁与执行口径（D1–D9）。
> 上游真源：`AGENTS.md`、`docs/VERIFY.md`、`docs/NOMI-FX-ITERATION-AND-BACKLOG-20261103.md`、`changes/tob-agent-workspace/需求文档.md`、`changes/tob-agent-workspace/技术方案.md`。
> 接力提示词索引：`docs/handoff/GOAL-0-PR1-CLOSEOUT-20261119.md`、`docs/handoff/GOAL-1-MVP-F0-GUARDRAILS-20261119.md`、`docs/handoff/GOAL-2-MVP-F1-F2-REFACTOR-20261119.md`。

---

## 1. 已锁定决策清单（D1–D9）

| 编号 | 决策主题 | 锁定结论 |
| --- | --- | --- |
| D1 | 战略路径 | 先打通 MVP-F0 硬缺陷 + F1/F2 轻重构（视情况先发个人版），再按序切入 ToB R1（多组织/RBAC/审计/迁移）+ R2（组织 Agent）。 |
| D2 | 分支与 PR #1 收口 | 先在当前分支 `feat/iteration-a-mvp-closeout` 将未提交的规范增量与 ToB 文档拆开提交、清理运行产物，人工审完合并 PR #1 → `dev` 后，再从干净 `dev` 切新分支推进 MVP-F0 与 F1/F2。 |
| D3 | 生产数据现状 | 尚未对外切流（无真实线上用户或仅内部测试数据），可接受短维护窗口执行结构迁移与历史 `exchange_rates` 脏汇率清洗（清理旧 `er-api`/`frankfurter` 反向缓存行），但仍保留幂等回填与备份副本一致性核对脚本。 |
| D4 | 安全与质量门禁 | 保留 Mimosa 的 Write/Edit 写入前扫描、卸载/降级 `git-gate` 为告警以恢复正常直提；同时为 `packages/money` 补齐 `fast-check` 属性测试，并将 `packages/eslint-config` 先按 `observe` 模式接入 `lint`。 |
| D5 | 免责声明措辞 | 选定 A 版（当前 `clients/chat-web/components/base/compliance-disclaimer.tsx` 默认 70 字完整书面语，个人版与未来 ToB 共用，无需修改代码，关闭该待办）。 |
| D6 | 执行与对抗审工具组合 | 全程以 Antigravity 为主阵地（`/grill-me` → `/plan` → `/goal` 或 `/teamwork` 执行），独立对抗审优先调用外部异构 CLI（如 Codex CLI），不可用时降级为 Antigravity 独立只读审查 Agent（并在 handoff 中显式披露）。 |
| D7 | Agent 自治边界 | 允许在特性分支内自主小步 commit、安装方案写明的 devDependency（如 `fast-check`）、push 特性分支并建/更新 draft PR；严禁 merge `dev`/`main`、严禁转 ready、严禁直接推 `dev`/`main` 或执行生产部署。 |
| D8 | Goal 切分粒度 | 接力式 Goal 序列：Goal #0（PR #1 工作区收口微任务）→ Goal #1（主力：护栏补齐 + MVP-F0 正确性硬门）→ Goal #2（MVP-F1/F2 性能契约重构 + ToB R1 前置门）。 |
| D9 | 规范与模板落盘 | 本方案与工作流手册落盘至 `docs/`，三份接力 Goal 提示词落盘至 `docs/handoff/`，并同步登记 `AGENTS.md` 与 `CLAUDE.md`。 |

---

## 2. 代码现状审计（6 类硬缺口）

以下问题全部经由仓库文件核查定位，不采信未经实测的旧文档勾选状态：

| 级别 | 问题分类 | 实测代码证据 | 风险与阻塞原因 |
| --- | --- | --- | --- |
| **P0 正确性** | **跨源汇率方向反转** | `services/chat/src/rate/rate-source.abc.ts:43,198-201` 返回「1 外币 = X 本位币」，而 `services/chat/src/rate/rate-source.erapi.ts:59-79` 与 `services/chat/src/rate/rate-source.frankfurter.ts:50-96` 直接透传「1 本位币 = X 外币」（倒数）；`e2e/scripts/run-e2e-tests.sh:91` 默认 `RATE_SOURCE=frankfurter` | TWD/MYR 与降级模式成本错一个量级；E2E 与生产默认源口径割裂 |
| **P0 闭环** | **日级报价原时点回补窗口失效** | `services/chat/src/rate/rate.service.ts:209-250` `findQuoteAt` 硬编码 5 分钟窗口 `(at - 5min, at]`，而日级源 `observedAt` 固定为 `00:00:00.000Z`（北京时间 08:00） | 非 08:00–08:05 UTC+8 时段建账与初始持仓币种更正必然报 `RATE_QUOTE_UNAVAILABLE` |
| **P0 闭环** | **USAGE 更正被挡板拦截** | `services/chat/src/correction/correction.service.ts:1080-1085` 统一拒收 `USAGE`，`e2e/modules/11-correction.spec.ts:249` 的 `T-CORR-004` 仍跳过。`README.md:15` 与 `changes/mvp-completion/审查报告-20261103.md:32` 已标为 🟡 降级待修 | 前端入口存在，服务端拒绝提交。先在 MVP-F0-3 验收个人版闭环，再扩展至 ToB |
| **P0 生产/精度** | **导出目录权限 + CSV 本位币精度与浮点累加** | `infra/compose/compose.prod.yaml:47-49` 挂载 `fxplanner-exports:/data/exports` 且设 `DATA_EXPORT_DIR: /data/exports`，而 `infra/compose/Dockerfile.chat:45-63` 切 `USER bun` 前未预建并 `chown -R bun:bun /data/exports` 与 `/app/services/chat/data-exports`；`services/chat/src/data-request/export-builder.ts:368-369` 用外币 `row.currencyCode` 格式化本位币字段 `principalAmount`/`feeAmount`，且第 `238-246` 行 `usageCostOf` 使用 `Number()` 浮点累加 | 生产容器导出 `EACCES` 失败；买入 JPY/KRW 时 CNY 本金与手续费被截成 0 位小数，成本累加存在浮点尾差 |
| **P1 性能/契约** | **SQL 放大、影子类型、查询噪声与双实现** | ① `services/chat/src/rate/rate.service.ts:461-476` `findLatestRows` 全历史拉取后内存去重；② `services/chat/src/data-request/data-request-lock.guard.ts:68-118` 每请求自验 JWT + 固定 2 条 SQL；③ `clients/chat-web/app/(protected)/layout.tsx:157` 无条件挂载 `<ReminderBell />` 触发未建账 409；④ `clients/chat-web/lib/api/contract.ts:92-150` 与 `clients/chat-web/lib/api/accounts.ts:14-68` 保留手写影子 DTO；⑤ `services/chat/src/correction/ledger-replay.ts` 与 `services/chat/src/usage/usage-calculator.ts` 双实现 FIFO 消耗 | 进入 ToB 多租户前若不收敛，会把 SQL 放大、契约撕裂与算法漂移成倍复制到组织模型 |
| **P1 护栏/依赖** | **验证工具链缺口与模板冗余依赖** | ① `packages/money/package.json` 缺 `fast-check`；② `scripts/test.ts:35-78` 与 `.github/workflows/ci.yml:47-118` 漏跑 `packages/money` 与 `packages/dev-log-server`；③ `services/chat/package.json:12` 与 `clients/chat-web/package.json:10` 的 `lint` 仅跑 `tsc --noEmit`；④ 6 个零引用依赖（`ali-oss`/`sharp`/`fabric`/`@gsap/react`/`react-zoom-pan-pinch`/`@dnd-kit/*`）与 0 引用的 `WorkflowCheckpoint`（`services/chat/prisma/schema.prisma:84-94`）；⑤ `AGENTS.md` 后端模块树列出不存在的 `project`/`database` 而漏列实际 17 个子目录，`packages/dev-log-server/README.md` 缺失 | `docs/VERIFY.md` 承诺的属性测试与真 `lint` 尚未自动兜底 |

---

## 3. 五阶段迭代与重构路线图

总原则：**先收口 PR #1 与补齐验证护栏（Phase 0）→ 先过个人 MVP 正确性硬门（Phase 1 / MVP-F0）→ 再做性能与契约结构收敛（Phase 2 / MVP-F1&F2）→ 再增量落地 ToB 组织地基（Phase 3 / R1）→ 最后放行可控组织 Agent（Phase 4 / R2）**。

```text
Phase 0 (PR #1 收口 + 护栏补齐)
   │  [Goal #0] + [Goal #1 任务 A]
   ▼
Phase 1 (MVP-F0 正确性硬门 + 脏汇率清洗)
   │  [Goal #1 任务 B–E] ──► 硬门全绿，可视需要先行发布个人 MVP
   ▼
Phase 2 (MVP-F1/F2 性能收敛 + 契约清零 + ESLint observe)
   │  [Goal #2] ──► 清除影子 DTO、N+1 锁查询、未建账 409、零引用依赖
   ▼
Phase 3 (ToB R1: 组织/RBAC/审计/数据请求拆分/MIG-A→F)
   │  [Goal #3] ──► 跨租户 API 矩阵与迁移一致性核对全绿
   ▼
Phase 4 (ToB R2: 组织只读 Agent 工具 + 草稿人工确认闭环)
```

---

### Phase 0：PR #1 收口与工程护栏补齐（1–2 天）

对应接力：**Goal #0**（收口 `feat/iteration-a-mvp-closeout`）与 **Goal #1 任务 A**（在合并 PR #1 后的干净 `dev` 新分支起步）。

1. **PR #1 工作区收口（Goal #0，不改业务代码）**：
   - 将未提交文档与规范增量（`AGENTS.md`、`CLAUDE.md`、`docs/VERIFY.md`、`docs/ITERATION-REFACTOR-ROADMAP-20261119.md`、`docs/VIBE-CODING-PLAYBOOK.md`、`docs/handoff/PR1-BEHAVIOR-ASSERTIONS-20261105.md`、`docs/handoff/GOAL-*.md`）与 `changes/tob-agent-workspace/`、V2.5 `.pen` 原型改动按主题拆分成清晰 commit；
   - 清理不入库运行产物（`docs/handoff/zcode-ui/*.png`、`test-results/`、`services/chat/data-exports/*.zip`、`services/chat/logs/dev.log`）；
   - 固化 D5 结论（免责声明采用 A 版，不改 `compliance-disclaimer.tsx`），并在 `README.md:15` 与 `changes/mvp-completion/审查报告-20261103.md:32` 将 USAGE 更正纠偏为 🟡（待 MVP-F0 验收后恢复 ✅）；
   - 按 D4 核验 Mimosa 配置：保留 Write/Edit 写入前扫描，降级或卸载 `git-gate` 为告警，验证无 `git -C` 旁路的正常直提；
   - 人工审查合并 PR #1 → `dev`。
2. **验证护栏补齐（Goal #1 任务 A）**：
   - `packages/money/package.json` 安装 `fast-check`，新增 `packages/money/src/round.property.spec.ts` 与 `packages/money/src/calc.property.spec.ts`；
   - 更新 `scripts/test.ts` 与 `.github/workflows/ci.yml`，把 `packages/money` 与 `packages/dev-log-server` 纳入统一测试与 CI；
   - 补齐 `packages/dev-log-server/README.md`，并同步修正 `AGENTS.md` 的 `services/chat/src/` 真实目录树（15 个业务模块 + `config`/`prisma`，移除 `project`/`database` 占位）。

**退出门**：工作区干净；`bun run typecheck`、`bun run test all`（真实包含 `packages/money` 属性测试与 `packages/dev-log-server`）0 failed。

---

### Phase 1：MVP-F0 正确性硬门（预计 3–5 天，对应 Goal #1 任务 B–E）

> **硬阻断规则**：本阶段 4 项未全部 0 failed 验收前，禁止对外上线个人 MVP，禁止启动 ToB 共享账本写入。

1. **F0-1 跨源汇率方向统一与历史脏数据清洗**：
   - 冻结系统唯一口径：`rate` / `sellRate` 恒为 **「1 外币（`quote`）= X 本位币（`base`）」**；
   - 改造 `services/chat/src/rate/rate-source.erapi.ts` 与 `services/chat/src/rate/rate-source.frankfurter.ts`（覆盖 `fetchLatestBatch` 与 `fetchHistory`）：使用定点运算或 `Decimal` 求倒数并按约定精度舍入，严禁 `1 / Number(raw)`；
   - 全仓核查消费方（`onboarding`、`transaction`、`report`、`market`、AI 汇率工具、`e2e/scripts/run-e2e-tests.sh:91`），确认无二次取倒数；
   - 依据 D3（无真实线上用户，可短维护窗口清洗），编写并验证幂等清理脚本（清理 `exchange_rates` 中历史 `er-api` / `frankfurter` 反向缓存行；清理与回补的执行口径以 `changes/realtime-rate/MVP-F0-汇率回补与缓存迁移计划-20261119.md` §3 为准——ErApi 免费档无历史端点、不可重拉，按本地快照原位转换）；
   - **必配测试**：ABC / ErApi / Frankfurter 三源同币对等价单测 + `fast-check` 倒数往返与极端币种属性测试。
2. **F0-2 日级报价时效与原时点回补修复**：
   - 在 `services/chat/src/rate/rate.constants.ts` 与 `rate.service.ts:209-250` 按源粒度区分实时源（5 分钟窗口）与日级源（按交易日/UTC+8 自然日回溯匹配；日级回看的可用性证据边界以 `changes/realtime-rate/MVP-F0-汇率回补与缓存迁移计划-20261119.md` §2 为准，无法证明原时点可用时保留 `RATE_QUOTE_UNAVAILABLE`），**严禁伪造 `observedAt`**；
   - **必配测试**：非 08:00–08:05 UTC+8（如 00:05、14:30、23:55 UTC+8）的建账初始化与初始持仓币种更正 API/集成测试。
3. **F0-3 USAGE 更正完整闭环 + 共享 FIFO 纯函数内核（联动 DEBT-01/02）**：
   - 从 `services/chat/src/correction/ledger-replay.ts` 与 `services/chat/src/usage/usage-calculator.ts` 抽出单一共享 FIFO 消耗纯函数内核，并以原 FIFO 镜像测试与 15 类计算用例回归锁定；
   - 移除 `services/chat/src/correction/correction.service.ts:1080-1085` 的 `USAGE` 挡板，实现加载、`baseVersion` 乐观校验、改小/改大/改日期影响预览、同事务重放与失败零副作用；保持同日 FIFO 排序不被截断（防止回归 `OVERNIGHT-ZCODE-20261103.md` 披露的 B1 同日截断问题）；
   - 取消 `e2e/modules/11-correction.spec.ts:249` `T-CORR-004` 的 `test.skip`，补全改小/改大/并发冲突/失败回滚测试并跑绿；全部通过后同步刷新 `changes/mvp-completion/审查报告-20261103.md` 与 `README.md`。
4. **F0-4 生产导出目录权限 + CSV 本位币精度**：
   - 修复 `infra/compose/Dockerfile.chat`：在切 `USER bun` 前创建 `/data/exports`（对齐 `infra/compose/compose.prod.yaml:47-49` 的 `DATA_EXPORT_DIR` 与卷挂载）与 `/app/services/chat/data-exports` 并 `chown -R bun:bun`；
   - 修复 `services/chat/src/data-request/export-builder.ts:368-369`（`principalAmount` 与 `feeAmount` 改用本位币 `data.settings?.baseCurrency ?? "CNY"` 格式化）与第 `238-246` 行（`usageCostOf` 改 `Decimal` 累加）；
   - **必配测试**：JPY/KRW 交易配 CNY 本位币精度单测 + 容器内 `bun` 用户写入实测（受环境限制时标注边界）。

**退出门**：L1（含 `fast-check`）+ L2 + L3（含 `T-CORR-004` 与关键全量 E2E）0 failed；独立对抗审 `[Important]` 清零；产物清理完毕。

---

### Phase 2：MVP-F1 & F2 性能、契约与结构重构（预计 3–4 天，对应 Goal #2）

1. **F1-1 最新汇率常数行查询**：改造 `services/chat/src/rate/rate.service.ts:461-476` `findLatestRows`，在数据库端按 `quote` 取最新 1 行（PostgreSQL `DISTINCT ON (quote)` 或经 `EXPLAIN ANALYZE` 验证走索引的等价查询），用测试锁定返回行数 ≤ `quotes.length`。
2. **F1-2 数据锁 Guard 查询合并与身份复用**：重构 `services/chat/src/data-request/data-request-lock.guard.ts`，将「到期推进查询」与「活动锁查询」合并为单次查询（无活动请求 ≤ 1 条 `data_requests` SQL，仅确有到期才清理），并调整执行位置避免与 `JwtAuthGuard` 重复验签，保留无效 token 401 与白名单推进；保留优化前后 Prisma query log 计数对照。
3. **F1-3 前端查询降噪与缓存 Key 集中化**：
   - 为 `clients/chat-web/app/(protected)/layout.tsx:157` 的 `<ReminderBell />` 及 reminders/settings hooks 加上「已建账且非锁定」的 `enabled` 门控，消除未建账 409；
   - 在 `clients/chat-web/lib/api/` 抽统一 Query Key 工厂与集中失效工具（为 Phase 3 注入 `organizationId` 做准备），并对 `apiClient` 的预期业务 4xx 与系统错误做日志分级。
4. **F2-1 清零手写影子 DTO**：补齐缺失后端 Swagger DTO 后，将 `clients/chat-web/lib/api/contract.ts:92-150` 与 `clients/chat-web/lib/api/accounts.ts:14-68` 全部改为 `schema.gen.ts` 类型别名，运行 `bun run --cwd clients/chat-web generate:api` 验证单一事实来源。
5. **F2-2 ESLint `observe` 接入与依赖/Schema 盘点**：
   - 按 D4 将 `packages/eslint-config` 以 `observe` 模式接入 `chat` 与 `chat-web` 的 `lint` 脚本（记录存量警告基线但不阻断既有代码，新增改动遵循规则，逐步演进至 `enforce`）；
   - 清理确认 0 引用的模板依赖（`ali-oss`/`@types/ali-oss`/`sharp`/`fabric`/`@gsap/react`/`react-zoom-pan-pinch`/`@dnd-kit/*`）；`WorkflowCheckpoint`（`services/chat/prisma/schema.prisma:84-94`）先盘点保留并在交接中记录去留依据；
   - 核对 Prisma schema relation 与数据库已有手工 FK（严防对 `plan_change_logs` 重复建 FK，保持 `CostLot.sourceId`/`Correction.targetId` 多态键现状），并在备份副本演练迁移。

**退出门**：`generate:api` + `typecheck` + `lint` + 全量 L1/L2/L3 0 failed；Prisma SQL 计数与 `EXPLAIN ANALYZE` 证据落盘。

---

### Phase 3：ToB R1 组织工作台、RBAC、审计与增量迁移（对应 `changes/tob-agent-workspace/技术方案.md` P1–P6）

结合 D3（无真实线上用户，可短维护窗口执行迁移）但仍严格保留六阶段逻辑与校验门，避免大爆炸改写：

1. **P1 身份、权限与迁移地基**：先更新 `AGENTS.md` 目录树，注册 `organization/`、`authorization/`、`audit/` 模块；执行 `MIG-A/B` 建 5 张核心表与业务表 `organizationId`/`createdById`；实现集中纯函数五角色权限策略与单测；验证幂等默认组织回填脚本。
2. **P2 组织上下文与只读隔离**：上线 `OrganizationContextGuard`（读 `X-Organization-Id` 实时查库验 `Membership`，不写进长期 JWT）与 `PermissionGuard`；前端接入 `organization-store`、`use-organizations` 与 `[domain, organizationId, ...]` Query Key，切换组织中止旧请求/SSE 并清空旧缓存；全量 GET 端点补跨组织 404 隔离测试。
3. **P3 成员生命周期、组织设置与审计**：落地邀请（高熵 token 仅存 `tokenHash`、7 天有效、邮箱严格匹配、单次使用）、角色变更、成员禁用（`DISABLED` 保留历史）、所有权转移（事务 + 部分唯一索引保证唯一 Owner）、只读审计分页页。
4. **P4 业务写 Actor 化与事务审计**：`account`/`plan`/`transaction`/`usage`/`correction`/`reminder`/`report`/`onboarding` 写操作改为接收 `ActorContext`，与 `AuditLog` 同事务；提醒已读拆为成员级 `ReminderRead`；组织化适配 F0 已验收的 `USAGE` 更正。
5. **P5 个人与组织数据请求拆分**：`DataRequest` 增加 `scope: PERSONAL | ORGANIZATION`，解耦个人注销与组织清空/删除；最后 Owner 注销返回 409 `LAST_OWNER_REQUIRED`；下载链接校验最新权限。
6. **P6 迁移核对与收紧（`MIG-C → F`）**：跑通 `changes/tob-agent-workspace/技术方案.md` §12.3 全量金额/分配/FIFO 核对脚本零差异后，收紧 `organizationId` 非空、替换唯一约束为 `(organizationId, currencyCode)`、清理旧兼容分支与旧设置字段。

**退出门**：`changes/tob-agent-workspace/技术方案.md` §14.2 跨租户 API 参数化矩阵、§14.3 集成流、§12.3 迁移核对与组织 E2E 全部 0 failed。

---

### Phase 4：ToB R2 可控组织 Agent（对应 `changes/tob-agent-workspace/技术方案.md` P7–P8，严格在 R1 验收后开启）

1. **P7 组织只读 Agent**：`AiConversation` 绑定 `organizationId`；工具工厂闭包注入不可被模型修改的 `ActorContext`（工具入参 zod schema 禁止出现 `userId`/`organizationId`/`role`）；每次工具调用前实时重查 `Membership` 与权限并写 `AuditLog`；上线 4 个只读工具 + 独立 AI 降级开关；补 Prompt Injection 与流中途移除成员集成测试。
2. **P8 计划草稿与人工确认闭环**：新增只读 `draft_fx_plan` 工具（禁止模型直接调 `create_plan`）；草稿确认页复用 `/plans/schedule-preview` 与 `POST /plans` 实时重算。

**明确后置（Defer，不挡个人版与 ToB R1/R2）**：i18n、单计划 PDF 直接下载、doc 12 收益比较数值、修改计划日期（功能 29）、电商订单实时同步、收款卖出账本、真实换汇执行与 SSO；以及 2026-11-28 拍板确认后置的「设置内变更本位币与停旧建新状态机（原 `SM05` / `STOPPED`，现阶段维持建账后锁定）」与「独立静态 `/terms`、`/privacy` 法务正文页（原 `WEB-03`，待正式运营主体信息落定后补齐，现阶段保持登录/注册勾选门槛）」。
