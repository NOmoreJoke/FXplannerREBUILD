# FXplannerREBUILD · Goal #3B 交接台账（ToB R1 Part B：账本写操作与数据权利拆分 · W22–W28）

- 分支：`feat/tob-r1-b-ledger-write-data-split`（基于 `dev` `36c125a1f8dfc25b8c4057705c888047c40d41f1`）
- 开始时间：2026-11-25 09:42 CST
- 编排模式：Antigravity Orchestrator + 独立隔离开发子代理（`self`）+ 独立只读对抗审查子代理（`research`）

## 1. 环境预检与工具降级披露

1. **Git / DB Pre-flight**：
   - `dev` 与 `origin/dev` 对齐于 `36c125a1f8dfc25b8c4057705c888047c40d41f1`（含 PR #10 `690ecfa`）；`stash@{0}` 完整未动；工作区洁净。
   - 本地数据库 `fxplanner_new_db_local` 运行中，初始 20 个迁移已同步；孤儿基线：`plan_allocations = 0`、`usage_lot_allocations = 0`、无成员孤儿组织 = `2156`、重复 `(organization_id, currency_code/dedupKey)` 计数均 = `0`、存量违约 `data_requests = 18`（将在 W26 规范化后再落 `CHECK` 约束）。
2. **外部引擎 / Computer Use 降级披露（依 `GOAL-3B` §2.3）**：
   - `codex exec -s read-only` 失败：`400 model_not_found`（`gpt-6.2-sol` 不可用）。
   - Computer Use（`/opt/homebrew/bin/peekaboo`）成功在副屏 `ZCode`（`window_id: 101`, `[-1478, 456]`）点击新建任务并确认项目/分支为 `FXplannerREBUILD · feat/tob-r1-b-ledger-write-data-split`，但跨屏 Electron 窗口焦点超时导致 `peekaboo paste` 返回 `Error: Paste hotkey did not return a confirmed outcome`（输入框仍空）。
   - 为严格守恒上下文与避免盲重试，按 §2.3 规则切换为：**独立 `self` 子代理逐切片开发（无交叉上下文污染） + 独立只读 `research` 子代理跨基线对抗审查（`git show dev:AGENTS.md` / `eslint.config.mjs` / `docs/VERIFY.md`） + Orchestrator 确定性终验与唯一提交**。

---

## 2. Orchestrator 切片执行与对抗审台账（W22–W28）

| 切片 | 主题 | 主开发引擎 | 对抗审引擎 | 审轮次 | `[Important]` 清零与修复摘要 | L1/L2 实测计数 | Commit SHA |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **W22** | 个人/组织设置分离 + 组织独立建账 + `OnboardingService` 并发锁 | `self` 子代理（Computer Use 降级披露见 §1） | `research` 只读子代理 + **ZCode** R1→R3 | R1→R2 / ZCode R1→R3 | 内部 R1 拦截 3 项 `[Important]` 并于 R2 清零；合入后经 ZCode 对 W22+W23 联合对抗审 R1 拦截 `I-1`（提前切 `MIG-E` 索引说明对齐）与 `I-2`（双账户行合并与回填冲突），R2 拦截 `R2-I1`（`planReservationWhere` 对称预留口径），修复后 ZCode R3 `0 [Important] PASS`。 | 11 文件 248/248（修复后全套 21 文件 434/434）；`orphan_orgs = 2156` | `a8463c9` |
| **W23** | `Transaction` 与 `Plan` 写接口 Actor 化、并发锁与同事务审计 + 联合 R1→R3 收口 | `self` 子代理（W23 + ZCode R1/R2 修复） | `research` 只读子代理 + **ZCode** R1→R3 | 内部 R1 + ZCode R1→R3 | 内部 R1 `0 [Important]`；**ZCode R1 拦截 `I-1`/`I-2` → 修复后 ZCode R2 拦截 `R2-I1` → 修复后 ZCode R3 `0 [Important] PASS`**（16→21 文件 434/434 全绿，`W23-PLAN-7`/`W23-PLAN-5` `-t` 通过，`generate:api` 双跑零 diff，`orphan_orgs = 2156`）。 | 21 文件 434/434 + `-t` 过；9 单测文件 128/128；`check:structure`/`lint`/`typecheck`（4/4）全绿；`orphan_orgs = 2156` | `188d84f` |
| **W24** | `Usage`、组织级 `USAGE` 更正与共享账本 FIFO 重放 | **ZCode**（`GLM-5.4 高`） | **MiniMax Code**（`M3.1-Flash high`）+ Orchestrator | R1（1 轮即过） | **MiniMax Code R1 `0 [Important] PASS`**（核验 5 项围堵全过、7 文件 112/112 + 全量 38 文件 558/558、`NO_DRIFT`、`orphan_orgs = 2156`）；Orchestrator 顺手回正 `N-5`（`correction.dto.ts:553` 缩进）并保留 ZCode 同步修复的存量 `swagger.spec.ts`（72→74 路由计数）；`N-1`/`P-2` 已加入 W25 报告核验范围。 | 11 切片 172 passed；20 条 `-t` 逐条通过；L1 1085 passed；L2 39/39 577 passed；`orphan_orgs = 2156` | `ffa9b37` |
| **W25** | 成员级 `ReminderRead`、`ReportService` 计划占用对称核验与 `AiConversation` 全端点组织隔离 | **MiniMax Code**（`M3.1-Flash high`） | **ZCode**（`GLM-5.4 高`） | R1（1 轮即过） | **ZCode R1 `0 [Important] PASS`**：四项围堵全过；`N-1`（`ReportService` 走 `planReservationWhere` 与 `PlanService` `compatReadWhere` 在未迁 NULL 计划上的兼容期可见性差）显式记账并纳入 Goal #3C `MIG-D` 准入核对；`N-2..N-5`、`P-2..P-3` 记入 backlog。 | 17 文件 247 passed（Step B 12/164 + ZCode 17/247）；13 条 `-t` 通过；OpenAPI 双跑零 diff；`orphan_orgs = 2156` | `cd35dd0` |
| **W26** | `DataRequest` 双域拆分、DB `CHECK` 约束、最后 Owner `409` / 过户不丢组织账本与 `07-plan-allocations.csv` 精度修复 | **ZCode**（`GLM-5.4 高`） | **MiniMax Code**（`M3.1-Flash high`） | R1（1 轮即过） | **MiniMax Code R1 `0 [Important] PASS`**：Step B 捕获并修复 `use-data-request.spec.tsx:55` 新契约 `scope` 类型报错；18 条历史 `CLEAR` 经 `20261125180000` 迁移无损转为 `ORGANIZATION`（PENDING 锁保留，0 违约）；`executePersonalDeletion` 先升序锁全部相关组织 + 锁内复验 + 原生 SQL 过户 `user_id`（清 `reminders.read_at`、保 `created_by_id`/`updated_at`）+ DMMF≡`pg_constraint` 15 表零残留断言；`07-plan-allocations.csv` 按计划 `targetCurrency` 走 `@fxplanner-new/money` 舍入并增「币种」列；W26 批准 `organization-reconcile.ts:265` 对齐、到期失权作废 `CANCELLED`、个人导出/注销独立于建账与 `cdrmig...` cuid 兼容 ID；`N-1`/`P-1` 交 W27 `OrganizationLockGuard` 收口，`N-2..N-4`/`P-2` 记账。 | Step B 后端 8 文件 **168/168** + 前端 34 文件 **327/327** + `-t` `CHECK`/`LAST_OWNER_REQUIRED` 全过（ZCode 后端全量 86 文件 1326 passed）；MiniMax 7 文件 165/165；OpenAPI 双跑零 diff；`orphan_orgs = 2156`、`dr_violations = 0` | `78b426d` |
| **W27** | `PersonalAccountLockGuard` 与横切 `OrganizationLockGuard` 物理拆分、合并 `<=1` 锁查询、`OrganizationDataRequestController`、导出下载降权/跨组织实时复验与 `DELETE /organizations/current` | **MiniMax Code**（`M3.1-Flash high`） | **ZCode**（`GLM-5.4 高`） | R1→R3 | **ZCode R3 `0 [Important] PASS`**：R1 拦 4 项（合并单条 `findMany <= 1` SELECT、类级 `@SkipOrganizationLock` 统一 `409 DATA_REQUEST_CONFLICT`、允许未建账删组织解死锁、下载复验），R2 拦 `R2-I1`（`wrongOrg` 用例未把 `finance` 在原组织复原为 `ACTIVE FINANCE`）；修复后完成变异自证，重命名 `CombinedLockResolution` 消同名冲突，补全 `OrganizationLockGuard` 401 分支、`I-4` 未建账死锁闭环、`GET /organizations/current` `findMany=1/findFirst=0` 与未到期请求非空断言；`N-7`（前端组织进度卡）明确归 W28 收口，个人注销期锁本人组织撤回归 `P-1` backlog。 | Step B `check:structure`/`lint`/`typecheck`(4/4) 全绿；OpenAPI(80 ops / 67 paths) 双跑零 diff；后端 9 套件 **179/179** + `-t` 定点全过；前端 34 套件 **328/328**；`pa_orphans=0 / ula_orphans=0 / orphan_orgs=2156` | `9ab05af` |
| **W28** | 前端权限自适应账本交互（`useOrganizationCapabilities` / `resolveLedgerQueryGate`）、设置双域拆分、数据权利双域 UI、`Picker` 退出闭环与查询降噪 | **ZCode**（`GLM-5.4 高`） | **MiniMax Code**（`M3.1-Flash high`） | R1（1 轮即过） | **MiniMax Code R1 `0 [Important] PASS`**：权限真源仅内存实时读取、`can(...)` fail-closed；`Personal`/`Org` 设置与数据权利双域彻底分流；`/data-requests` 兼容纯 URL（不拼 `?scope=`）且闭合 W27 `N-7`；`409 LAST_OWNER_REQUIRED` 展示阻塞组织并提供 `/organization` 引导；5 领域写入口全部能力门控、零新裸 `useEffect`/定时器/`@ts-ignore`/影子 DTO；`Nit`（测试矩阵夹具、2 处未消费导出、`preferences-form` 分段 key、组织详情失败时下载入口）均不阻断。 | Step B `check:structure`/`lint`/`typecheck`(4/4) 全绿；前端 **35 套件 / 422 passed**（净增 94 条）；`next build` exit 0（21 页面） | `be4277b` |
| **D6 修复** | `I-1` 个人注销收口保护存活默认组织未回填 `NULL` 账本行、`I-2` CSV 公式注入中和、`I-3` 组织删除错误提示与凭证重置、`I-4` `legacyOnly` 回退回归、对齐 `N1`/`N3` | **MiniMax Code**（`M3.1-Flash high`） | **ZCode**（`GLM-5.4 高`） | D6 R1→R2 | **ZCode D6-R2 `0 [Important] PASS`**：`collectSharedOrganizationIds` 纳入持 `NULL` 行或依赖 `OWNER_LEGACY` 的默认组织；`executePersonalDeletion` 在锁内固化设置、按 `membership -> lockOrgLedgerAccounts` 锁序原生 SQL 收口 9 表再过户并保留 `usageRecord -> legacy Plan`；`escapeCsvField` 中和 `/^[=+\-@\t\r]/`（豁免纯负数）；`OrganizationDeletionFlow` 补 `onError`；`organization-read-isolation` 钉住 `{ legacyOnly: true }`。 | Final Gate：L1（`unit` 46/717, `web` 35/422, `money` 4/64, `dev-log` 4/31, `scripts` 8/8）+ L2（`api` 21/440, `integration` 18/146, `infra` 1/24）+ `build` exit 0 + `generate:api` 零 diff + DB `0/0/2156/0` | `795a428` |

### W22 详述
- **Schema & 迁移（提前切出 `MIG-E` 唯一索引项，保留已应用迁移校验和）**：`services/chat/prisma/migrations/20261125094500_tob_r1_mig_c_org_unique_indexes/migration.sql` 将原属 `技术方案.md` `MIG-E` 的 `Account` / `InitialHolding` / `Reminder` 唯一索引提前在 W22 切换至组织维度（`@@unique([organizationId, ...])`），以使 W22/W24 多组织同币种独立建账与记账不撞 `P2002`；同时保留 `WHERE "organization_id" IS NULL` 部分唯一索引（`accounts_legacy_user_currency_uidx`、`initial_holdings_legacy_user_currency_uidx`、`reminders_legacy_user_dedup_scheduled_uidx`）及非唯一 `(user_id, ...)` 查找索引兼容存量/未迁移写路径。`organization_id SET NOT NULL`、`User` `ON DELETE CASCADE` 解绑及清理过渡部分唯一索引（`DROP INDEX IF EXISTS`）已同步对齐至 `Goal #3C` W30 `MIG-E`（该范围调整经 Orchestrator 审批并显式记录于 `GOAL-3B` 与 `GOAL-3C`）。
- **机械兼容垫片（`Option A`）**：因 `Account` 移除 `@@unique([userId, currencyCode])`，Prisma DMMF 不再生成 `userId_currencyCode` 唯一输入键；在 `transaction.service.ts`（W23 已整体重写作组织化）、`usage.service.ts`、`correction.service.ts` 与 `test/helpers/plan-test-helper.ts` 中做了 `userId_currencyCode` → `findFirst`/`update`/`create` 机械兼容垫片，未改动 W24 业务逻辑边界。
- **W22+W23 联合对抗审收口（ZCode R1→R3）**：
  - ZCode R1 拦截 `I-1`（诚实披露提前切索引并同步 Goal #3B/#3C 文档）、`I-2`（`resolveDefaultOrganizationCreatorUserId` + `lockOrgLedgerAccounts` / `upsertOrgAccountWithLegacyMerge` / `mergeLegacyOrgAccountIfExists` 消除受邀成员与创建者并发写触发 `P2002` 与双行分裂，`MIG-B` 回填合并双行账户/去重提醒并阻断冲突初始持仓，`reconcileMigration` 新增 `dual_rows.*` 检查）、以及 `[Nit]` `N-1`/`N-3`/`N-5`/`N-8`/`N-9`/`N-11`/`N-12`/`N-16`/`N-17` 与 `ensureOnboarded` `legacyOnly` 修复 `R2-I03`；
  - ZCode R2 拦截并修复 `R2-I1`（`planReservationWhere` 对称纳入默认组织创建者存量 `organizationId: null` 计划占用，覆盖 `PlanService.computeCaps`、`PlanService.loadAdjustContext` 与 `AccountService.sumAllocatedByCurrencyForUser`，消除成员升级账户后忽略 Owner 存量计划导致超额分配），并移除死参数 `_legacyScope`、补齐 `W23-PLAN-5` `adjust`/`complete` 审计故障回滚与 `W23-PLAN-7` 真实 DB 回归；**ZCode R3 实证通过（`Important count: 0`）**。

---

## 3. 全分支 Final Gate 终验（`795a428` 收口后实测）

- **裁判基线未受篡改**：`git diff dev -- eslint.config.mjs docs/VERIFY.md scripts/check-structure.ts clients/chat-web/next-env.d.ts` 输出为空；无 `e2e/test-results/`、`playwright-report/`、`logs/` 残留目录。
- **契约一致性**：`bun run --cwd clients/chat-web generate:api` 连跑两遍 SHA-256 逐字节零 diff（`openapi.json` 67 paths / 80 ops）。
- **静态门禁**：`bun run check:structure`、`bun run lint`、`bun run typecheck`（4/4 packages + 2 Prisma CLI configs）全部 exit 0；`lint-observe` 分支改动门禁 0 违规。
- **L1（5 套件全绿）**：
  - `unit`：`Test Files 46 passed (46)`，`Tests 717 passed | 1 todo (718)`（`1 todo` 为 `correction-calculator.spec.ts` 存量）
  - `web`：`Test Files 35 passed (35)`，`Tests 422 passed (422)`
  - `money`：`Test Files 4 passed (4)`，`Tests 64 passed (64)`（`fast-check` 属性测试）
  - `dev-log`：`Test Files 4 passed (4)`，`Tests 31 passed (31)`
  - `scripts`：`8 pass / 0 fail`
- **L2（3 套件全绿，真实 PostgreSQL `fxplanner_new_db_local`）**：
  - `api`：`Test Files 21 passed (21)`，`Tests 440 passed (440)`
  - `integration`：`Test Files 18 passed (18)`，`Tests 146 passed (146)`
  - `infra`（`test/prisma.spec.ts`）：`Test Files 1 passed (1)`，`Tests 24 passed (24)`
- **全端构建**：`turbo run build` exit 0（NestJS + Next.js 16.2.3 Turbopack 21 路由）。
- **数据库一致性 SQL 复核**：`pa_orphans = 0`、`ula_orphans = 0`、`orphan_orgs = 2156`、`dr_violations = 0`。

---

## 4. 关键质量加固与 `07-plan-allocations.csv` 精度/公式防线证据

1. **`07-plan-allocations.csv` 目标币种精度修复（W26）**：`export-builder.ts:536-561` 按所属计划 `targetCurrency` 调用 `@fxplanner-new/money` 舍入（JPY/KRW 0 位整数、USD/EUR/CNY 等 2 位小数），并独立新增 `"币种"` 列（孤儿行不猜测精度、原样输出库内值）。
2. **CSV 公式注入中和（D6 `I-2` 收口）**：`export-builder.ts:230-238` `escapeCsvField` 对 `/^[=+\-@\t\r]/`（豁免纯负数 `/^-[0-9]+(\.[0-9]+)?$/`）统一加 `'` 前缀并以双引号包裹，防组织名/计划名/会话标题触发跨成员表格公式注入，`export-builder.spec.ts`（32/32）全覆盖。
3. **个人注销兼顾存活默认组织 `NULL` 存量行（D6 `I-1` 收口）**：`data-request-cleanup.ts` 将「仍持 `NULL` 账本行或靠 `OWNER_LEGACY` 承托的默认组织」并入 `collectSharedOrganizationIds`，`executePersonalDeletion` 在锁内固化设置、按 `membership -> lockOrgLedgerAccounts` 锁序原生 SQL 收口 9 张账本表再过户（`usageRecord -> legacy Plan` 关联不断链），无存活默认组织时照常删除并保证 15 表 `assertNoRemainingUserReferences` 零残留。

---

## 5. 全分支 `D6` 对抗性审查与不阻断 Backlog

- **ZCode Whole-Branch `D6`**：R1（独立隔离副本实跑 + 全分支 `dev...HEAD`）拦截 4 项 `[Important]` → 经 MiniMax Code 修复与 Final Gate 全绿复跑 → ZCode R2 实测复核全部闭合（`Important count: 0` / `Adversarial-Review: D6-R2 0 [Important] PASS`）。
- **可留待后续清理的 `[Nit]` / `[Pre-existing]` Backlog**（均不阻断合并前 E2E 验收）：
  - `N4` / W28 C：`DataRequestViewDto` 暂无 `isRequester` 字段，有能力但非发起人点击撤回/下载由后端 404 拦截并提示；后续可补充视图字段。
  - `N6`–`N10`（前端细节）：`can()` 后台 refetch 失败态 / 组织详情加载失败错误提示与重试 / `CLEAR PROCESSING|FAILED` 门控 / `home/page.tsx` loading 骨架顺序 / `plan-list.tsx` 能力加载中提示闪烁；`use-organization-capabilities.spec.tsx` 测试夹具共享。
  - `P-1`（DataRequest）：个人注销期间 `organization-data-request.controller.ts` 未标 `@SkipPersonalAccountLock()`，本人组织清空在个人撤回期内需由本人先撤回个人注销后再撤回组织请求。
  - `P1`（存量写入口链接）：`accounts/page.tsx:62,142`、`account-ledger-table.tsx:127`、`report-plan-list.tsx:217` 入口链接与 `dev` 相同未门控（目标页与后端均已门控）。
  - `P7`：`eslint.config.mjs:41` `LEGACY_USE_EFFECT_FILES` 仍列着已移除 `useEffect` 的 `preferences-form.tsx`（本分支遵守裁判基线未动该文件，建议随基础工程小 PR 移除）。
  - `F1`/`F2`（D6-R2）：`data-request-cleanup.ts` 仅当直写库造出同币种 `initial_holdings` 冲突时 `INITIAL` `cost_lots` 会软悬空；可随后续收敛改为像 `MIG-B` 一样 fail-closed 或清理对应批次。

---

## 6. 人类启服后 E2E 回归清单（必跑）

AI 遵守禁令未启动 `dev`/`compose up`/E2E，以下用例需人类在启动服务后实跑验收：

1. `e2e/modules/15-organization.spec.ts`（ToB R1 基础与角色视图回归）
2. `e2e/modules/12-account-data.spec.ts`（**预期有 2 条需同步更新 E2E 用例口径**）：
   - `T-DATA-002`：原断言个人导出文案含「币种」，W26 后个人导出不含账本金额，应改断言 `organization-data-export` 面板说明；
   - `T-DATA-006`：种子用户为默认组织唯一 Owner，现按 W26 规范被后端 `409 LAST_OWNER_REQUIRED` 拦截并展示阻塞组织引导，需先添加第二 Owner 或删除组织后再验个人注销。
3. 账本写路径与防呆专项：`e2e/modules/08-onboarding-wizard.spec.ts`、`09-ledger-writes*`、`10-initial-backfill.spec.ts`、`11-correction.spec.ts`、`11-reminders.spec.ts`、`14-ai-chat.spec.ts`。

---

## 7. Goal #3C（`MIG-C→F`）准入就绪检查表

本分支已严格恪守不越权边界，以下均完整留给 **Goal #3C**：
- [x] `MIG-C`（`20261125094500`）与 `20261125180000` 已应用迁移校验和完整未改，本地库违约行为 `0`；
- [x] **未**对 11 张业务表执行 `organization_id SET NOT NULL`、**未**删除旧 `user_id` 列、**未**解绑 `User` `ON DELETE CASCADE` 外键、**未**删除兼容部分唯一索引；
- [x] `ReportService`（`planReservationWhere`）与 `PlanService`（`compatReadWhere`）在 `organization_id IS NULL` 过渡行上的可见性差异已记账（Goal #3C 须先完成全量 `MIG-B` 回填再切 `MIG-D/E/F`）；
- [x] `DataRequestLastOwnerRequired` 个人注销已覆盖兼容期 `NULL` 存量行保护；Goal #3C 落地 `MIG-E/F` 后可进一步清理 `legacy` 分支与过渡垫片。

