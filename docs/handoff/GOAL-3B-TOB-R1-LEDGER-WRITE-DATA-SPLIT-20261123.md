# Goal #3B — FXplannerREBUILD · ToB R1 共享账本写 Actor 化、提醒与数据请求拆分（P4–P5）

> 适用阶段：Phase 3 · ToB R1 Part B（对应 `技术方案.md` P4 业务写接口 Actor 化与同事务审计 + P5 `DataRequest` 个人/组织双域拆分与双锁重构）
> 接力序列：`Goal #3A (P1–P3)` → **`Goal #3B (W22–W28)`** → `Goal #3C (P6 迁移收紧与退出门)` → `Goal #4 (R2 Agent)`
> 前置门控：**必须在 Goal #3A Draft PR 已合入 `dev`，且 `MIG-A/B` + `OrganizationContextGuard` + `AuditModule` 已在 `dev` 基线稳固运行后启动**
> 上游真源：`AGENTS.md`、`docs/VERIFY.md`、`changes/tob-agent-workspace/需求文档.md`（§7.3, §8, §9.1, §11, §15.3, §15.5）、`changes/tob-agent-workspace/技术方案.md`（§4.3–§4.4, §5.2, §6, §9, §10.2–§10.3, §13.1, §14）、`docs/handoff/OVERNIGHT-TOB-R1-A-YYYYMMDD.md`、`docs/handoff/OVERNIGHT-MVP-F1-F2-20261122.md`
> 建议特性分支：`feat/tob-r1-b-ledger-write-data-split`

---

## 1. 背景与开工前只读硬门核验

- 仓库：`/Users/kyle/Documents/工作/知爻/FXplannerREBUILD`
- 开工核验 checklist：
  1. `git fetch origin && git status -s`：确认 `dev` 已合入 `Goal #3A`（`organization`/`authorization`/`audit` 模块、`MIG-A/B`、`OrganizationContextGuard`、前端 `organization-store` 等就绪）。
  2. 核对 `docs/handoff/OVERNIGHT-TOB-R1-A-YYYYMMDD.md`：确认无遗留 `[Important]` 未闭环。
  3. 必读 `changes/tob-agent-workspace/技术方案.md` §4.3–§4.4、§5.2–§5.3、§6.2、§9、§13.1，以及 `docs/handoff/OVERNIGHT-MVP-F1-F2-20261122.md` 记录的既有技术债清单。
  4. 切出分支：`git checkout -b feat/tob-r1-b-ledger-write-data-split dev`。

---

## 2. 分支、自治与作用域红线（违反即打回）

- **Git 自治边界（D7）**：仅在 `feat/tob-r1-b-ledger-write-data-split` 内按 W22–W28 提交，push 特性分支并创建 **Draft PR** → `dev`。**严禁** push/merge `dev`/`main`，**严禁**转 Ready。
- **服务禁令**：AI 严禁启动 dev 服务或 Playwright E2E Runner。
- **严格作用域边界**：
  - **禁止提前执行 `MIG-E`/`MIG-F` 破坏性收紧**（`organizationId` 仍保持过渡或双写兼顾直到 `Goal #3C` 执行 §12.3 全量核对后再 `NOT NULL` 与删旧字段，避免切换中断）；
  - **禁止提前实现 ToB R2 组织 Agent 工具与计划草稿**（本 Goal #3B 的 W25 **只做** `AiConversation` 绑定 `organizationId` 与跨组织会话隔离，工具接入留给 `Goal #4`）；
  - **全部业务写与 `AuditLog` 必须在同一 Prisma 事务内**（§13.1：审计失败导致业务写回滚，绝不允许「账已改但审计丢」）。
- **静态护栏**：零手写影子 DTO（改 DTO 后必跑 `generate:api`）；前端页面/业务组件零裸 `useEffect` 与定时器；新测试禁止 `skip`/`sleep`/删断言。

---

## 3. 原子级垂直切片清单（W22–W28）

### W22（P4-1）：个人/组织设置分离 + 组织首次建账（`LEDGER-02`）+ 账户锁并发加固
- **目标**：把本位币/准备偏好/提醒开关/记账起点正式从 `UserSettings` 解耦至 `OrganizationSettings`（`UserSettings` 仅保留个人 `locale`/`region`），并让新组织独立完成首次建账。
- **顺手收口 Goal #2 延后项 ①**：在 `OnboardingService` 中补齐组织级账本行锁（`lockLedgerAccounts(tx, ...)`，消除首次建账与并发交易间的账户余额竞态）。
- **改动文件**：
  1. `services/chat/src/settings/`（`settings.controller.ts`, `settings.service.ts`, `dto/settings.dto.ts`）：
     - 拆清读取与更新口径：`PATCH /api/settings` 拆为「个人偏好（`locale`/`region`，无需组织写权，不校验 `settings.update` 权限）」与/或明确区分个人端点 vs `@RequiresPermission("settings.update")` 的组织设置端点（`prepPreference`/`reminderEnabled`，写 `OrganizationSettings` + 同事务 `AuditLog`）；保持 `baseCurrency` 建账后只读锁死不开放更新。
  2. `services/chat/src/onboarding/`（`onboarding.controller.ts`, `onboarding.service.ts`, `dto/onboarding.dto.ts`）：
     - 挂载 `OrganizationContextGuard` + `PermissionGuard` + `@RequiresPermission("settings.update")`（Operator/Viewer 不能建账）；
     - 将建账（`saveConsents` 仍记个人 `TermsConsent`；`complete` 与 `initial-holdings` 写入当前组织 `OrganizationSettings` 与带 `organizationId` / `createdById` 的 `Account`、`InitialHolding`、`CostLot`），事务内先获取组织级账本锁再落账，并同事务写入 `AuditLog`；
     - 注册链路配合调整（确保个人注册后自动生成默认组织，且按单组织新用户默认进入独立建账向导）。
  3. 同步 `generate:api`。
- **必配测试**：
  - `services/chat/test/api/settings.spec.ts` & `onboarding.spec.ts` + `services/chat/test/integration/onboarding.spec.ts`：
    - 用户属 Org A（已建账）与 Org B（未建账）：B 完成建账不影响 A；Viewer/Operator 对 B 提交 `POST /api/onboarding/complete` 或 `PATCH` 组织设置报 `403 PERMISSION_DENIED`；
    - 审计写入故障注入测试：模拟 `auditLog.create` 失败 → `OrganizationSettings` / `InitialHolding` / `Account` 全部回滚；
    - `OnboardingService` 并发建账/补录锁安全性回归。
- **Commit**：`feat(ledger-write): migrate settings and onboarding to organization scope with tx audit` — `Verified: unit, api, integration`
- **Checkpoint**：个人设置与组织设置边界清晰；组织独立建账与同事务审计全绿。

---

### W23（P4-2）：交易（`Transaction`）与计划（`Plan`）写接口 Actor 化、并发锁加固与同事务审计（`LEDGER-01`）
- **目的**：将买入交易创建、换汇计划创建/调整/完成/取消/重开的写路径改为接收 `ActorContext`，写入 `organizationId` + `createdById`/`actorUserId`，并保持精确权限区分：**Operator 可写 Plan，但禁止写 Transaction**（`AUTH-01`）！
- **顺手收口 Goal #2 延后项 ②**：`TransactionService` 买入创建事务纳入组织级 `lockLedgerAccounts` 并发锁，确保 FIFO 批次号/账户余额与并发使用/更正完全串行安全。
- **改动文件**：
  1. `services/chat/src/prisma/ledger-write-lock.ts`：扩展支持按 `(organizationId, currencyCodes)`（双写阶段同时兼容新老锁粒度或统一用 `organizationId` 顾问锁）加事务锁。
  2. `services/chat/src/transaction/`（`transaction.controller.ts`, `transaction.service.ts`, `dto/transaction.dto.ts`）：
     - `POST /api/transactions` 要求 `@RequiresPermission("transaction.create")`（Owner/Admin/Finance ✓，Operator/Viewer 403）；
     - 事务内按 `organizationId` 加 `lockLedgerAccounts`、查本位币取 `OrganizationSettings`、创建 `Transaction` + `CostLot`（带 `organizationId` + `createdById: actor.userId`）并写 `AuditLog`；
     - 同步返回/详情 DTO 可暴露必要创建者展示摘要，执行 `generate:api`。
  3. `services/chat/src/plan/`（`plan.controller.ts`, `plan.service.ts`, `dto/plan.dto.ts`）：
     - `POST /api/plans/schedule-preview`、`GET`/`POST /api/plans`、`PATCH /api/plans/:id`、`POST /api/plans/:id/{complete,cancel,reopen}`：分别标注 `@RequiresPermission("plan.create")` / `@RequiresPermission("plan.adjust")`（Owner/Admin/Finance/Operator ✓，Viewer 403）；
     - `Plan`、`PlanInstallment`、`PlanAllocation`、`PlanChangeLog` 全部写入 `organizationId` + `createdById`/`actorUserId`（`PlanChangeLog.actorUserId`）并同事务写 `AuditLog`；
     - **组织级计划排期锁**：`PlanService` 对组织名下 `Account` 与 `Plan` 行加锁（防止 A 成员调计划分配的同时 B 成员超额分配同一币种）。
- **必配测试**：
  - `services/chat/test/api/transaction.spec.ts` & `services/chat/test/api/plan.spec.ts`：
    - `OPERATOR` 创建 Plan 成功（201），提交 `POST /api/transactions` 被拒（403 `PERMISSION_DENIED` 且写 `DENIED` 审计、余额不变）；
    - `VIEWER` 调任何写接口 403；跨组织 Plan ID 调整/完成/取消统一返回 404；
    - 多成员并发写交易 + 并发创建分配计划，断言余额/未分配金额与 `AuditLog` 条数完全一致。
- **Commit**：`feat(ledger-write): migrate transaction and plan writes to ActorContext with tx audit` — `Verified: unit, api`
- **Checkpoint**：Operator/Finance 权限矩阵精确区分；交易/计划并发与审计原子性全绿。

---

### W24（P4-3）：使用记录（`Usage`）、组织级 `USAGE` 更正与 FIFO 共享重放（`LEDGER-04`）
- **目的**：完成 `UsageService` 与 `CorrectionService`（覆盖 `TRANSACTION`、`INITIAL_HOLDING`、**`USAGE`** 全部更正类型）的组织范围化，保留 Goal #1 已验收的共享 FIFO 内核与同日排序不变量，并确保并发修改冲突检测（`baseVersion` + 影响重算）在多人协作下可靠触发。
- **改动文件**：
  1. `services/chat/src/usage/`（`usage.controller.ts`, `usage.service.ts`）：
     - `POST /api/plans/:planId/usages`（或既有使用录入路由）要求 `@RequiresPermission("usage.create")`（Operator/Viewer 403）；
     - 事务内按 `{ id: planId, organizationId: actor.organizationId }` 查父 Plan 并加锁，加载同组织全量活跃 `CostLot`（不再只查个人！即成员 A 录入的买入批次可以被成员 B 记录的使用消费），写入 `UsageRecord`（`organizationId`, `createdById`）与 `UsageLotAllocation` 并写 `AuditLog`。
  2. `services/chat/src/correction/`（`correction.controller.ts`, `correction.service.ts`, `ledger-replay.ts`, `dto/correction.dto.ts`）：
     - `preview` 要求 `@RequiresPermission("correction.preview")`，`apply` 要求 `@RequiresPermission("correction.apply")`（Operator/Viewer 403）；
     - 严守 §4.4：全链路重放（`CostLot`、`Transaction`、`InitialHolding`、`UsageRecord`、`UsageLotAllocation`、`Plan`、`PlanAllocation`、`Account`）全部按 **`organizationId`** 筛选与加锁，保留同日时间顺序；
     - `Correction` 记录写入 `organizationId` 与 `actorUserId: actor.userId`（展示审计/更正日志中的实际操作者），同事务写 `AuditLog`；
     - 并发冲突场景（成员 A 预览后成员 B 变更目标或新增使用，A 用旧 `baseVersion` 提交）稳定返回冲突错码且业务零副作用（`LEDGER-04.2`）。
- **必配测试**：
  - `services/chat/test/integration/organization-ledger-isolation.spec.ts`：A/B 两组织同币种同金额操作（买入 → 计划分配 → 使用 → 更正 → 报告），断言 FIFO 成本、账户余额、使用分配、日志绝对零串联；同一组织内 Finance 1 买入 + Finance 2 使用 & 更正，FIFO 跨成员共享账本严格一致！
  - `services/chat/test/integration/correction-replay.spec.ts`：扩展多成员协同下的 `USAGE` 更正改小/改大/改日期、`baseVersion` 冲突拒绝与审计回滚测试；
  - `services/chat/test/api/correction.spec.ts` & `plan-usage.spec.ts`（含 `OPERATOR` 尝试录入/更正被 403 拒绝）。
- **Commit**：`feat(ledger-write): migrate usage, correction, and FIFO replay to shared organization ledger` — `Verified: unit, api, integration`
- **Checkpoint**：共享账本 FIFO 镜像/使用更正 0 回归；跨组织完全隔离；多成员并发版本号冲突稳定拦截。

---

### W25（P4-4）：成员级提醒（`ReminderRead`）、报告导出（`Report`）与 `AiConversation` 组织绑定（`LEDGER-03`, `AGENT-01`）
- **目的**：消除提醒已读互相覆盖、确保报告严格按组织汇总、并将 AI 会话绑定至当前组织（为 R2 做铺垫，但不提前放行组织 Agent 工具）。
- **改动文件**：
  1. `services/chat/src/reminder/`（`reminder.controller.ts`, `reminder.service.ts`）：
     - 提醒事件归属于 `organizationId`（按组织当前 `ACTIVE` 计划派生事项），而「已读状态」写入成员私有的 `ReminderRead(reminderId, userId, readAt)`；
     - `POST /api/reminders/:id/read` 与 `POST /api/reminders/read-all` 仅校验登录成员具备组织访问/读权限且记录属于当前组织，只写当前 `actor.userId` 的 `ReminderRead`（**严禁**更新共享 `Reminder.readAt` 让其他成员误变已读，`LEDGER-03.2`）；
     - 被移除（`DISABLED`）成员不再收到组织提醒。
  2. `services/chat/src/report/`（`report.controller.ts`, `report.service.ts`）：
     - `@RequiresPermission("report.read")`；全部汇总/成本核算查询加 `organizationId` 边界，跨组织 `planId` 返回 `404`；暴露创建人/更新人摘要若进 DTO 需 `generate:api`。
  3. `services/chat/src/ai/`（`ai.controller.ts`, `ai.service.ts`）：
     - 为所有 `/ai/*` 端点接入 `OrganizationContextGuard` + `@RequiresPermission("agent.use")`；
     - 新建会话写入 `{ userId: actor.userId, organizationId: actor.organizationId }`；会话列表、消息查询、追问、删除严格以 `{ id, userId: actor.userId, organizationId: actor.organizationId }` 为唯一查询条件（切组织或被移出后访问旧会话返回 404，`AGENT-01`）；
     - 工具清单仍保持现有个人/公共汇率能力，**不提前添加 ToB R2 业务工具与草稿工具**；同步 `generate:api`。
- **必配测试**：
  - `services/chat/test/api/reminder.spec.ts` & `test/integration/reminder-plan-lifecycle.spec.ts`（同一组织 A/B 两人各自读提醒，互不清空未读态；跨组织提醒 404）；
  - `services/chat/test/api/report.spec.ts` & `test/api/ai-chat.spec.ts`（U1 在 Org A 建会话，切 Org B 头访问/追问/删除 Org A 会话全部返回 404；被 Org A 移除后访问返回 404 `ORGANIZATION_NOT_FOUND`）。
- **Commit**：`feat(reminder,report,ai): add member-scoped ReminderRead, org-scoped reports, and AiConversation org binding` — `Verified: api, integration`
- **Checkpoint**：双成员提醒已读互不干扰；AI 会话跨组织严格 404 隔离。

---

### W26（P5-1）：`DataRequest` 个人/组织逻辑拆分、`CHECK` 约束与最后 Owner 保护（`DATA-01`, `MIG-01`）
- **目的**：按 `技术方案.md` §9.1–§9.2 彻底解耦「个人账号导出/注销」与「当前组织导出/清空/删除」，消除个人注销误删共享企业账本风险。
- **顺手收口 Goal #2 延后项 ③④**：
  - `services/chat/src/data-request/export-builder.ts`：修复 `07-plan-allocations.csv` 导出精度字段格式与一致性（保留 Decimal 累加不回归）；
  - `services/chat/src/data-request/data-request.service.ts` `executeCleanup`：改为条件原子认领（`updateMany({ where: { id, status: { in: ["PENDING", "FAILED"] } }, data: { status: "PROCESSING" } })`），关闭 Goal #2 W9 复查发现的 `[Pre-existing]` 并发重复推进窗口。
- **改动/新建文件**：
  1. Prisma DDL Migration（`<ts>_tob_r1_data_request_scope_check`）：为 `data_requests` 增加数据库 `CHECK` 约束：
     - `scope = 'PERSONAL' AND type IN ('EXPORT', 'DELETION') AND organization_id IS NULL`
     - `OR (scope = 'ORGANIZATION' AND type IN ('EXPORT', 'CLEAR', 'DELETION') AND organization_id IS NOT NULL)`
  2. `services/chat/src/data-request/data-request-rules.ts`（更新同目录单测 `data-request-rules.spec.ts`）：实现 `scope × type` 合法校验、各自锁语义判定、最后 Owner 注销阻止条件、`AuditLog` 组织保留处理规则。
  3. `services/chat/src/data-request/data-request.service.ts`、`dto/data-request.dto.ts`：
     - **个人域**：`PERSONAL EXPORT`（导出个人资料、偏好、所属组织摘要、个人会话元数据，**不包含他人/企业财务明细**，不锁业务）；`PERSONAL DELETION`（校验用户是否为任一组织唯一 `ACTIVE OWNER` → 若是，强制拒绝并返回 **`409 LAST_OWNER_REQUIRED`** + 阻塞组织列表；通过后只清理个人身份/个人会话/个人同意/禁用或移除已可离任 Membership，**绝不级联删除所属组织账本**！）；
     - **组织域**：
       - `ORGANIZATION EXPORT`（需 `@RequiresPermission("data.export")` + OTP，导当前组织账本与报告，`07-plan-allocations.csv` 精度同步修复，不锁业务）；
       - `ORGANIZATION CLEAR`（需 `@RequiresPermission("data.clear")` + OTP，7 日冷静期/可撤回，到期清空当前组织业务数据并重置 `OrganizationSettings.ledgerStartedAt = null`，同事务写 `AuditLog`，**不影响其他组织**）；
       - `ORGANIZATION DELETION`（`DELETE /api/organizations/current` 或创建 `ORGANIZATION DELETION` 请求，需 `@RequiresPermission("organization.delete")`（仅 Owner）+ OTP；到期显式事务清理当前组织全部派生表，`AuditLog` 按隐私策略随组织清算或脱敏收口，**不删除任何成员个人 User 账号**）。
- **必配测试**：`services/chat/src/data-request/data-request-rules.spec.ts`（`PERSONAL CLEAR` 等非法组合拒绝）+ 精度测试 `export-builder.spec.ts`（补充 `07-plan-allocations.csv` 精度断言）+ 并发原子认领单测。
- **Commit**：`feat(data-request): split PERSONAL and ORGANIZATION scopes, add DB CHECK, last-Owner guard, and CSV precision fix` — `Verified: unit, diff`
- **Checkpoint**：DB `CHECK` 阻断非法 `scope/type/orgId` 组合；个人注销不再触碰任何组织业务数据；`07-plan-allocations.csv` 精度全过。

---

### W27（P5-2）：双锁守卫拆分（`PersonalAccountLockGuard` + `OrganizationLockGuard`）与导出降权校验（`DATA-02`, §9.3）
- **目的**：按 `技术方案.md` §4.3 & §9.2–§9.3 将原单一全局 `DataRequestLockGuard` 清晰拆分为个人锁与组织锁，严格保持 W9 验收的 **单次查询上限 + 异常 fail-closed + 读时推进** 不变量！
- **改动/新建文件**：
  1. 个人锁守卫 `PersonalAccountLockGuard`（`data-request/`）：查当前 `userId` 名下 `scope = 'PERSONAL'` 进行中 `DELETION` 请求；仅 1 条索引 `findMany` 完成推进与锁定（`403 ACCOUNT_PENDING_DELETION`）；非白名单 DB 异常 **fail-closed (500)**；物理删除 `User` 时调用 `RequestAuthService.invalidateRequestUser(request)` 返回 `401`；不因个人状态锁死他人同组织的读写。
  2. 组织锁守卫 `OrganizationLockGuard`（置于 `OrganizationContextGuard` 之后、`PermissionGuard` 之前，§4.3）：
     - 根据 `actor.organizationId` 查 `scope = 'ORGANIZATION'` 活跃 `CLEAR` / `DELETION` 请求（最多 1 条 `findMany`）；
     - 到期即事务推进；锁定返回 `403 ORGANIZATION_DATA_LOCKED`（个人注销保留 `ACCOUNT_PENDING_DELETION`，§7.1）；
     - **白名单端点（进度页/撤回/下载）**：依然按 §4.3 要求先过 `OrganizationContextGuard` + 权限校验（成员被移除后无法再通过旧下载链接下载导出文件，`DATA-02.5`）；
     - 同样遵循非白名单 DB 查询异常 **fail-closed (500)**。
  3. 数据请求 Controller 接口拆分/适配（清晰区分个人请求端点与 `/api/organizations/current/data-requests/*` 或带 scope 端点，全部完善 Swagger DTO 并 `generate:api`）。
- **必配测试**：`services/chat/test/integration/organization-data-lifecycle.spec.ts` & `services/chat/test/api/data-request.spec.ts`：
  - 个人注销锁触发时：`ACCOUNT_PENDING_DELETION` 拦截个人写与业务请求，但 Org 另一活跃成员在同一组织内正常操作（`DATA-02.1`）；
  - Org A 进入 `CLEAR PENDING`/`PROCESSING` 或 `DELETION` 锁：Org A 写返回 `403 ORGANIZATION_DATA_LOCKED`，而同一用户在 Org B 所有操作完全正常（`DATA-02.2`）；
  - 成员生成组织导出文件后被降权（如降为 Viewer）或 `DISABLED` 移除 → 再使用旧下载 URL 请求 → 立即拒绝（403/404，`DATA-02.5`）；
  - 最后 Owner 尝试创建 `PERSONAL DELETION` → `409 LAST_OWNER_REQUIRED`（`DATA-02.4`）；转移所有权或删掉最后一个唯一组织后再次发起成功；
  - Prisma SQL 计数断言：无活动数据请求时单次组织受保护请求最多各 1 条 `data_requests`（个人+组织均满足单查询不变量且异常 fail-closed）。
- **Commit**：`feat(data-request): split PersonalAccountLockGuard and OrganizationLockGuard with download re-auth` — `Verified: unit, api, integration`
- **Checkpoint**：个人/组织锁矩阵、导出成员降权失效、最后 Owner 保护、单 SQL 与 fail-closed 全绿。

---

### W28（P4/P5-3）：前端权限感知交互、双域数据中心页与 Reminder 组织已读对接
- **目的**：按 `需求文档.md` §13 & `技术方案.md` §10.2–§10.3 将 W22–W27 的全部新能力在前端稳妥落地（**无手写 DTO、无裸 `useEffect`、无把前端 capabilities 当唯一安全防线**）。
- **改动文件**：
  1. `clients/chat-web/lib/api/`：按最新 `schema.gen.ts` 更新 `settings.ts`（区分个人/组织偏好保存）、`data-requests.ts`（个人请求 vs 组织导出/清空/删除端点、最后 Owner 409 结构解析与引导）、`query-keys.ts`（个人 data-requests vs `withOrgScope(orgId, ...)` 组织 data-requests 分开隔离，且补全 `invalidateAfterDataRequestMutation` 的组织维度传参）；
  2. `clients/chat-web/lib/hooks/`：新增/更新 `use-organization-capabilities.ts`（基于当前组织 `capabilities` 提供 UI 禁用/隐藏提示）、`use-data-request.ts`、`use-reminders.ts`（无组织/当前组织未完成建账/组织锁定时阻断无效 409 请求）；
  3. `clients/chat-web/components/business/settings/`：将个人偏好（`locale`/`region`）与组织设置（本位币只读、准备偏好、提醒开关）清晰拆区，Viewer/Operator 对组织设置不可编辑只读展示；
  4. `clients/chat-web/components/business/{plan,transaction,usage,correction,account-data}/` & `app/(protected)/{data-requests,settings,onboarding,plans,accounts,transactions,corrections,reports,reminders}/page.tsx`：
     - 根据 `capabilities` 控制「记一笔（`transaction.create`）」「使用/更正（`usage.create` / `correction.apply`）」「建计划（`plan.create`）」按钮展示或显式无权提示；
     - 展示记录创建者/操作者标签（`LEDGER-01.4`、`LEDGER-04.4`）；
     - `/data-requests` 拆分为**「当前组织数据权利（导出/清空/删除组织）」**与**「个人账号数据权利（个人导出/注销账号）」**两个独立面板；个人注销遇 `409 LAST_OWNER_REQUIRED` 展示阻塞组织清单并附跳往「成员设置/转移所有权或组织管理」直达链接；
     - 组织锁（`403 ORGANIZATION_DATA_LOCKED`）与个人锁（`403 ACCOUNT_PENDING_DELETION`）在 `client.ts` / `chat.ts` 与锁进度卡独立处理，互不误跳或屏蔽真实 4xx/5xx。
- **必配验证**：
  - `PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run test web`（更新并扩展 `use-data-request.spec.tsx`、`use-reminders.spec.tsx`、`client.spec.ts`，验证个人/组织请求隔离、未建账零 409、最后 Owner 409 错误处理）；
  - `bun run lint && bun run typecheck`（保证 0 裸 `useEffect`、0 `setTimeout`、0 影子 DTO）；
  - `PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run build`。
- **Commit**：`feat(web): add capability-aware ledger actions and split personal/organization data-request UI` — `Verified: unit, diff`

---

## 4. 全量验证门禁与独立对抗审

1. **Diff 触发检查**：`git diff --name-only dev...HEAD`，核对 Prisma（`data_requests` CHECK 约束）、全后端业务 Controller 权限与锁链、FIFO 重放、`export-builder` CSV 精度、OpenAPI 0 diff。
2. **L1 + L2 + `build` 全跑**：
   - `bun run check:structure && bun run lint && bun run typecheck`
   - `PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run test unit web scripts money dev-log`
   - `bun run db:status && bun run test api integration infra`
   - `PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run build`
   - 确认测后本地库孤儿行检查 `plan_allocations` / `usage_lot_allocations` 仍为 `0`。
3. **独立对抗审（D6）**：重点审计：**写事务与 `AuditLog` 严格同事务失败同回滚**、**Service 零 `userId` 绕过组织查询**、**FIFO 多人并发使用/更正无竞态**、**个人注销零影响企业账本 + 最后 Owner 双重防线**、**导出链接成员降权/禁用失效**、**双锁 DB 异常 fail-closed**。所有 `[Important]` 清零后重跑受影响套件。

---

## 5. 提交、交接与 Goal #3C 准入门输出

- `.changeset/tob-r1-b-ledger-write-data-split.md`
- push `feat/tob-r1-b-ledger-write-data-split` → **Draft PR** → `dev`
- 生成 `docs/handoff/OVERNIGHT-TOB-R1-B-YYYYMMDD.md`：包含 W22–W28 Commit 清单、并发锁/审计/FIFO/双域数据请求全部集成测试计数、`07-plan-allocations.csv` 修复证据、对抗审记录，以及 **`Goal #3C` 执行 `MIG-C→F` 数据核对与约束收紧的前置确认项**。
