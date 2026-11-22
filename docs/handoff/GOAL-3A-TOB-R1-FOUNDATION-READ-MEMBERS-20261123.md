# Goal #3A — FXplannerREBUILD · ToB R1 地基、只读隔离与成员/审计闭环（P1–P3）

> 适用阶段：Phase 3 · ToB R1 Part A（对应 `技术方案.md` P1 身份权限迁移地基 + P2 组织上下文与只读隔离 + P3 成员邀请/角色/禁用/所有权转移/审计）
> 接力序列：`Goal #2 (PR #9)` → **`Goal #3A (W13–W21)`** → `Goal #3B (W22–W28)` → `Goal #3C (W29–W32)` → `Goal #4 (R2 Agent)`
> 前置门控：**必须在 PR #9 已合入 `dev`、`dev` 与 `origin/dev` 同步，且人工确认 `PHASE1-EXIT-STATUS-20261122.md` 中 `T-AI-003` 已闭环（或给出明确书面豁免单）后启动**
> 上游真源：`AGENTS.md`、`docs/VERIFY.md`、`docs/ITERATION-REFACTOR-ROADMAP-20261119.md`（D1–D9）、`changes/tob-agent-workspace/需求文档.md`、`changes/tob-agent-workspace/技术方案.md`、Goal #2 验收交接 `docs/handoff/OVERNIGHT-MVP-F1-F2-20261122.md`
> 建议特性分支：`feat/tob-r1-a-foundation-read-members`

---

## 1. 背景与开工前只读硬门核验（第一步，不满足立即停机）

- 仓库：`/Users/kyle/Documents/工作/知爻/FXplannerREBUILD`
- 开工核验 checklist：
  1. `git fetch origin && git status -s`：确认本地 `dev` 已含 PR #9 全部提交（`2aa75a8..71728a9`）且 `dev` 与 `origin/dev` 对齐；工作区无未归档脏改动。
  2. 核对 `docs/handoff/PHASE1-EXIT-STATUS-20261122.md` 与 `docs/handoff/OVERNIGHT-MVP-F1-F2-20261122.md` §5：
     - 确认 `T-AI-003`（`e2e/modules/14-ai-chat.spec.ts` 追问流 `ERR_ABORTED`）及 Goal #2 PR #9 的 L3 E2E 已由人类跑绿收口，或得到人类显式书面豁免继续 R1；
     - 确认本地 PostgreSQL 在线（`bun run db:status`）且已留存可恢复本地备份库以供 `MIG-A/B` 演练。
  3. 必读基线（禁止跳读）：
     - `AGENTS.md`（目录树铁律与文件归属）
     - `docs/VERIFY.md`（Diff 触发与三类防愚弄测试）
     - `changes/tob-agent-workspace/需求文档.md` §6–§8、§10、§12、§13、§15.1–§15.2、§17
     - `changes/tob-agent-workspace/技术方案.md` §4–§8、§12–§15、§16–§18
     - `docs/handoff/OVERNIGHT-MVP-F1-F2-20261122.md`（Goal #2 ESLint observe / bare-FK 盘点）
  4. 通过后从干净 `dev` 切出：`git checkout -b feat/tob-r1-a-foundation-read-members dev`。

---

## 2. 分支、自治与作用域红线（违反即打回）

- **Git 自治边界（D7）**：仅在 `feat/tob-r1-a-foundation-read-members` 内按切片 W13–W21 小步 Conventional Commit（尾部附 `Verified: ...`），push 本特性分支并创建 1 个 **Draft PR** → `dev`。**严禁** push `dev`/`main`、**严禁** merge、**严禁**转 PR 为 Ready。
- **服务禁令**：按 `AGENTS.md`，**AI 严禁启动前后端服务**（`dev` / `compose up` / `run-e2e-tests.sh`）。L3 E2E 仅编写用例并交由人类启动服务后运行。
- **严格隔离作用域（防大爆炸）**：
  - 本 Goal #3A **只覆盖 P1 + P2 + P3（基础架构、迁移 A/B、权限与审计模块、组织 CRUD/成员/邀请/审计接口、业务 GET 组织隔离、前端组织外壳与成员/邀请/审计页）**；
  - **严禁**在本 Goal 修改业务写接口逻辑（account/plan/transaction/usage/correction/onboarding/settings 写迁移与 `DataRequest` 拆分留给 `Goal #3B`）；
  - **严禁**在本 Goal 切换前端业务页对旧单写接口的无头/多组织写契约（仅兼容期内单一默认组织回落 + 只读切组织隔离）；
  - **严禁**在本 Goal 实现 ToB R2 Agent 工具与草稿（留给 `Goal #4`）。
- **静态护栏红线**：
  - 业务组件与新页面**严禁裸写 `useEffect` 与 `setTimeout`/`rAF`/`rIC`**（`eslint.config.mjs:158-200`）；受控副作用统一进 `clients/chat-web/hooks/` 或 `lib/hooks/`；
  - 前端 **严禁**引入 `services/chat/**`，共享类型**必须**来自 `bun run --cwd clients/chat-web generate:api` 后的 `schema.gen.ts`，零手写影子 DTO；
  - 前置核对目标目录下新增文件不得违反 `AGENTS.md` 目录树，先改 `AGENTS.md` 再写新模块。
- **3 轮自愈熔断 & Flaky 零容忍**：同一构建/测试失败连续 3 轮未解决即停机保留现场汇报；严禁删断言、加 `sleep`、加 `skip` 刷绿。

---

## 3. 原子级垂直切片清单（W13–W21）

### W13（P1-0）：目录契约对齐、ESLint 模块依赖护栏与纯函数权限策略（`AUTH-01`）
- **目的**：先立目录树、模块边界和纯函数 RBAC 策略真源，再写任何 DB/Nest 模块。
- **改动文件**：
  1. `AGENTS.md`：更新目录树与「文件归属规则」表，登记后端 `services/chat/src/{organization,authorization,audit}/`、前端 `clients/chat-web/app/(protected)/organization/`、`clients/chat-web/app/(protected)/invitations/`（核对 `proxy.ts` 与 `(protected)/layout.tsx` 跳转行为决定路由挂载位置）、`clients/chat-web/components/business/{organization,audit}/`、`clients/chat-web/lib/stores/organization-store.ts`、`e2e/modules/15-organization.spec.ts`（或留到 Goal #3C）。
  2. `eslint.config.mjs`：按 `技术方案.md` §4.1 增加后端模块单向依赖规则（`no-restricted-imports`）：
     - `organization/`、`authorization/`、`audit/` 与业务模块（`account/plan/transaction/usage/correction/reminder/report/home/onboarding/settings/data-request`）**禁止**反向引入 `src/ai/**`；
     - `authorization/` 仅可依赖 `organization` 的最小 Membership 读契约与 `prisma`/`auth` 类型，**禁止**引入业务记账模块；
     - `audit/` **禁止**引入业务模块或提供 update/delete 变更接口。
     - 完成「正向全量 `bun run lint` 通过 + 负向 `--stdin` 违规引用拦截（exit 1）」双重反证。
  3. `services/chat/src/authorization/authorization.types.ts`：定义 `OrganizationRole`（`"OWNER" | "ADMIN" | "FINANCE" | "OPERATOR" | "VIEWER"`）、`Permission` 全量枚举（`organization.{read,update,delete}`、`member.{read,invite,update,remove}`、`owner.transfer`、`settings.{read,update}`、`account.read`、`plan.{read,create,adjust}`、`transaction.{read,create}`、`usage.{read,create}`、`correction.{read,preview,apply}`、`report.read`、`audit.read`、`data.{export,clear}`、`agent.{use,business_read,draft}`）、`ActorContext`（`userId`, `organizationId`, `membershipId`, `role`, `authMethod`）。
  4. `services/chat/src/authorization/permission-policy.ts`：纯函数策略表 `ROLE_PERMISSIONS` 与集中决策纯函数：
     - `can(role, permission)`（未知角色默认 `false`）
     - `canManage(actorRole, targetRole, action)`（Admin **严禁**修改/降权/移除 Owner 或提升任何人到 Owner；非自我/合规边界规则）
     - `canAcceptInvitation(actorEmail, invitationEmail, now, state)`（邮箱小写 trim 规范化比对 + 未过期/未撤回/未接受/未拒绝）
     - `canTransferOwnership(actor, targetMembership)`（仅 `ACTIVE` 成员可接任，Owner 转己禁止）
     - `canDeleteOrganization(actor, organizationLock)`（仅 Owner 且无冲突状态）
- **必配测试**：`services/chat/src/authorization/permission-policy.spec.ts`（5 角色 × 全部 22+ 权限点完整矩阵 + 未知角色拒绝 + Admin 禁管 Owner/禁邀 Owner + 大小写/空白邮箱邀请匹配 + 过期/撤回/已使用状态枚举）。
- **Commit**：`feat(authz): register ToB directory boundaries and pure RBAC policy` — `Verified: unit, diff`
- **Checkpoint**：`bun run check:structure && bun run lint && bun run typecheck && bun run --cwd services/chat test src/authorization/permission-policy.spec.ts` 全绿；ESLint `--stdin` 跨模块反向引用反证通过。

---

### W14（P1-1 / `MIG-A`）：增量 Prisma Schema、迁移 SQL 与空壳兼容性锁定
- **目的**：严格按 `技术方案.md` §5.1–§5.3、§12.1 `MIG-A` 落盘纯增量 Schema 与 DDL，保证**存量个人 MVP 接口与全量既有测试零破坏**。
- **改动文件**：
  1. `services/chat/prisma/schema.prisma`：
     - 新增 5 张核心模型：`Organization`、`Membership`（`@@unique([organizationId, userId])`、`@@index([userId, status])`、`@@index([organizationId, status, role])`）、`OrganizationInvitation`（`tokenHash String @unique`、`@@index([organizationId, email, createdAt])`）、`OrganizationSettings`（`organizationId String @unique`）、`AuditLog`（`@@index([organizationId, createdAt(sort: Desc)])`、`@@index([organizationId, actorUserId, createdAt(sort: Desc)])`、`detail Json?`）；**严禁**在 `Organization` 冗余存 `ownerId`。
     - 新增成员级提醒已读表 `ReminderRead`（`reminderId`, `userId`, `readAt`, `@@unique([reminderId, userId])`，对齐 §5.2 与 `LEDGER-03`）。
     - 在既有 11 张业务表上按 `MIG-A` **增量可空**追加字段与索引（保留原 `userId` 非空与现有约束不动）：
       - `Account`：`organizationId String?`, `createdById String?`, `@@index([organizationId, currencyCode])`
       - `Transaction`：`organizationId String?`, `createdById String?`, `@@index([organizationId, transactedAt])`
       - `InitialHolding`：`organizationId String?`, `createdById String?`, `@@index([organizationId, currencyCode])`
       - `CostLot`：`organizationId String?`, `@@index([organizationId, currencyCode, acquiredAt])`
       - `Plan`：`organizationId String?`, `createdById String?`, `@@index([organizationId, status])`
       - `PlanChangeLog`：`organizationId String?`, `actorUserId String?`, `@@index([organizationId, planId, createdAt(sort: Desc)])`
       - `UsageRecord`：`organizationId String?`, `createdById String?`, `@@index([organizationId, usedAt])`
       - `Correction`：`organizationId String?`, `actorUserId String?`, `@@index([organizationId, targetType, targetId])`
       - `Reminder`：`organizationId String?`, `@@index([organizationId, scheduledFor])`
       - `AiConversation`：`organizationId String?`, `@@index([userId, organizationId, updatedAt(sort: Desc)])`
       - `DataRequest`：`scope String @default("PERSONAL")`、`organizationId String?`、`@@index([organizationId, status])`（暂不删改原 `userId`）
       - `PlanInstallment` / `PlanAllocation` / `UsageLotAllocation` 按 §5.2 随父隔离（若清理/导出直查加可空 `organizationId` 须同步父子一致索引与断言，或明确在 `organization-scope.ts` 统一随父约束）。
     - **不碰** `ExchangeRate`、`Currency`、`TermsConsent`、`OtpIdentity`、`OtpChallenge`、`WorkflowCheckpoint`。
  2. `services/chat/prisma/migrations/<ts>_tob_r1_mig_a_org_foundation/migration.sql`：
     - 除 Prisma 生成的建表与索引外，**手工追加数据库部分唯一索引（Partial Unique Index）**保护单活跃 Owner 不变量：
       `CREATE UNIQUE INDEX memberships_single_active_owner_uidx ON memberships (organization_id) WHERE role = 'OWNER' AND status = 'ACTIVE';`
     - 验证 `prisma migrate diff` 无意外漂移。
  3. `services/chat/test/prisma.spec.ts`：新增测试验证 `memberships_single_active_owner_uidx` 阻断同组织双活跃 Owner、`OrganizationInvitation.tokenHash` 唯一性、新增可空列不影响原有个人建账/写入流程。
- **验证**：`bunx dotenv -e .env.local -- bunx prisma migrate deploy`（或本地测试库部署）+ `bun run typecheck` + `bun run test unit api integration infra`（全部既有 MVP 测试必须 **0 failed**）。
- **Commit**：`feat(prisma): add MIG-A organization, RBAC, audit schemas and nullable org columns` — `Verified: infra, api, integration`
- **Checkpoint**：局部 Owner 唯一索引生效；既有全量 L1/L2 测试零回归。

---

### W15（P1-2 / `MIG-B` + §12.3 核对脚手架）：幂等默认组织回填与一致性核对 CLI
- **目的**：按 `技术方案.md` §12.2 & §12.3 在本地可恢复测试库验证存量个人数据 → 默认组织幂等回填与零差异核对（**禁止**在 Goal #3A 提前删除/禁用 `userId` 读路径）。
- **改动/新建文件**：
  1. `services/chat/src/organization/organization-backfill.ts`（纯/可复用迁移逻辑）+ CLI 入口 `services/chat/prisma/tob-r1-migration/backfill.ts`（仿 `services/chat/prisma/rate-cache-migration/` 先例，带 `README.md` 并登记入 `AGENTS.md` 与 `services/chat/tsconfig.json`/typecheck）：
     - 支持 `--dry-run` 与 `--apply`；严格遵循 §12.2 全部 7 条规则：
       1. 每 `User` 生成唯一默认 `Organization`（名称：`${user.name || emailPrefix}的工作台`）及 `OWNER / ACTIVE` `Membership`（通过已存在 `OWNER` Membership 判断幂等，不重复新建）；
       2. 若存在 `UserSettings`，幂等写入 `OrganizationSettings`（保留原 `baseCurrency`/`prepPreference`/`reminderEnabled`/`ledgerStartedAt`）；若无 `UserSettings`，保持待建账（不虚构 `OrganizationSettings`）；
       3. 按 `userId` 分批回填 `Account`/`Transaction`/`InitialHolding`/`CostLot`/`Plan`/`UsageRecord`/`Correction`/`Reminder`/`AiConversation` 的 `organizationId` 与 `createdById`/`actorUserId`（只更新 `organizationId IS NULL` 的行，保持原有 ID/金额/版本/时间戳不变）；
       4. `PlanChangeLog` 按父 `Plan.organizationId` 校对回填，检测孤儿/父缺失立即报错阻断；
       5. 已有 `Reminder.readAt IS NOT NULL` 幂等回填一条对应 `ReminderRead` 行；
       6. `DataRequest`：`EXPORT`/`DELETION` 置 `scope='PERSONAL'`；历史 `CLEAR` 映射到默认组织（`scope='ORGANIZATION'`, `organizationId`）。
  2. `services/chat/src/organization/organization-reconcile.ts` + CLI `verify` 子命令：实现 `技术方案.md` §12.3 全量一致性核对（每币种 `Account.balance`、每 `Plan` 金额/分配/已用/批次、记录条数与金额合计、`CostLot` 剩余与分摊合计、设置与记账起点、父子 `organizationId` 一致性），输出结构化差异清单（目标：0 diffs）。
  3. 同步更新 `AGENTS.md`（登记 `services/chat/prisma/tob-r1-migration/`，不污染根目录 logs/test-results）。
- **必配测试**：`services/chat/test/integration/organization-migration.spec.ts`：
  - 构造含多币种持仓、交易、计划、分配、使用、更正、已读提醒、AI 会话、EXPORT/CLEAR/DELETION 数据请求的完整存量用户 + 无设置新用户；
  - 执行第 1 次回填 → 校验 §12.3 核对 0 差异 → **第 2 次重复执行回填（幂等验证）** → 无新增组织/无重复记录；
  - 构造父记录缺失/跨组织异常行 → 断言 `verify` 显式报错阻断而不静默跳过。
- **Commit**：`feat(migration): add idempotent MIG-B default-org backfill and parity verifier` — `Verified: unit, integration`
- **Checkpoint**：本地备份库演练 `MIG-B` + `verify` 连续两次全绿、0 差异。

---

### W16（P1-3）：`AuditModule`（同事务审计 writer + 只读分页 API）与 `organization-scope.ts`
- **目的**：按 `AUDIT-01..03` & `技术方案.md` §4.4, §5.1, §7.2, §13.1–13.2 建立不可篡改审计与租户范围纯函数库。
- **改动/新建文件**：
  1. `services/chat/src/audit/audit.module.ts`、`audit.service.ts`、`audit.controller.ts`、`dto/audit.dto.ts`、`audit-sanitizer.ts`：
     - `recordInTx(tx, entry)`：强制接收事务客户端 `Prisma.TransactionClient`（与业务同事务提交或同回滚）；`recordStandalone(entry)` 仅用于纯读拒绝审计（如 Viewer 越权被拒 `DENIED`）。
     - `sanitizeAuditDetail(raw)`（纯函数）：字段白名单 + 深度/字节上限截断，强制剔除 `password`、`passwordHash`、`token`、`tokenHash`、`code`、`codeHash`、`secret`、`apiKey`、`messages` 原文（`AUDIT-02` & §13.2）。
     - `GET /api/organizations/current/audit-logs`：只读分页查询（cursor/page + 按时间起止、`actorUserId`、`action` 筛选；DTO 含 Swagger 注解；**严禁** POST/PATCH/PUT/DELETE 接口）。
  2. `services/chat/src/authorization/organization-scope.ts`：纯函数作用域构建器（`orgWhere(actor)`、`ownedRecordWhere(id, actor)`、`assertParentChildSameOrg(parentOrgId, childOrgId)`），禁止任何「先按 id 查全表再比对 orgId」的反模式（§4.4 #5）。
  3. `services/chat/src/app.module.ts`：按 `AGENTS.md` 唯一注册点规则注册 `AuditModule`、`AuthorizationModule`、`OrganizationModule`（模块间无循环依赖）。
- **必配测试**：
  - `services/chat/src/audit/audit-sanitizer.spec.ts`：敏感字段剥离、超大 JSON 截断、只读行为；
  - 事务原子性测试（随 `organization-lifecycle.spec.ts` 或 `audit.service.spec.ts`）：构造审计写入抛错 → 验证关联业务写同事务回滚（零脏写入）。
- **Commit**：`feat(audit): add transactional AuditModule with sensitive detail redaction and org-scope helpers` — `Verified: unit, api`
- **Checkpoint**：`audit` 无任何写/删端点；敏感字段脱敏单元测试全绿。

---

### W17（P2-1）：`AuthorizationModule` Guards（`OrganizationContextGuard` / `PermissionGuard`）与组织基础 CRUD API（`ORG-00..02`）
- **目的**：上线 `技术方案.md` §4.3 真实成员与权限链，且**严格不破坏无组织头的现有个人端行为**（通过 `@UseGuards` 显式挂载在组织/新端点，或在 W18 受控兼容窗口内接入业务 GET）。
- **改动/新建文件**：
  1. `services/chat/src/authorization/decorators/`（`requires-permission.decorator.ts`、`current-actor.decorator.ts`、`organization-route.decorator.ts`）与错误族 `services/chat/src/authorization/authorization.errors.ts`：
     - 统一错误码：`400 ORGANIZATION_REQUIRED`、`404 ORGANIZATION_NOT_FOUND`、`403 PERMISSION_DENIED`。
  2. `services/chat/src/authorization/guards/organization-context.guard.ts`：
     - 依赖 `RequestAuthService`（复用 W9 请求级身份，**不**重复验签）与 `PrismaService`；
     - 从 `request.headers["x-organization-id"]` 读取 `cuid`（缺失或格式非法且未启用兼容窗口 → `400 ORGANIZATION_REQUIRED`；非字符串数组严格拒绝）；
     - **实时查询** `prisma.membership.findUnique({ where: { organizationId_userId: { organizationId, userId } } })`（首版不做角色缓存，`AUTH-02`）；若不存在或 `status !== "ACTIVE"` → 统一 **`404 ORGANIZATION_NOT_FOUND`**（隐藏组织存在性，禁止返回 403 泄露）；
     - 构造 `request.actor: ActorContext`。
  3. `services/chat/src/authorization/guards/permission.guard.ts`：
     - 读取 `@RequiresPermission(...)` 元数据，调用 `can(actor.role, required)`；失败时可选写 `DENIED` 审计并抛 `403 PERMISSION_DENIED`。
  4. `services/chat/src/organization/`（`organization.module.ts`、`organization.controller.ts`、`organization.service.ts`、`organization-rules.ts`、`dto/organization.dto.ts`）：
     - `GET /api/organizations`（个人登录端点，不挂 `OrganizationContextGuard`）：列出用户全部 `ACTIVE` Membership 对应组织、`role`、`onboardingCompleted`、`baseCurrency`；
     - `POST /api/organizations`：创建新组织 + `OWNER / ACTIVE` Membership + 空设置（未建账，`ORG-01.4/5`）+ 同事务 `AuditLog`；
     - `GET /api/organizations/current`（`@RequiresPermission("organization.read")`）：返回当前组织详情、`actor.role`、`capabilities` Map（全部 `Permission` 布尔值，供前端渲染按钮，后端真源）、组织锁与建账状态；
     - `PATCH /api/organizations/current`（`@RequiresPermission("organization.update")`）：改名等基础字段 + 同事务 `AuditLog`；
     - 更新注册与建账路径（需仔细评估向后兼容）：为注册流程新增支持（或随兼容规则）确保新用户默认组织自动创建机制不破坏既有 auth API/E2E（`auth.spec.ts` / `onboarding.spec.ts`），若暂保持注册兼容窗口须明示写入注释并在 W22 收口。
  5. 更新审计端点 `GET /api/organizations/current/audit-logs` 挂载 `JwtAuthGuard -> OrganizationContextGuard -> PermissionGuard` + `@RequiresPermission("audit.read")`（仅 Owner/Admin/Finance 可读，Operator/Viewer 403）。
- **必配测试**：`services/chat/test/api/organization.spec.ts`、`services/chat/test/api/audit.spec.ts`：
  - 覆盖 §14.2 通用矩阵：无 token 401、缺 `X-Organization-Id` 400 `ORGANIZATION_REQUIRED`、非成员/他组织 404 `ORGANIZATION_NOT_FOUND`、`DISABLED` 成员 404、Operator/Viewer 调 `PATCH /current` 或 `GET /audit-logs` 返回 403 `PERMISSION_DENIED`；
  - 降权立即生效：同一旧 JWT 持有人在 DB 被改为 `VIEWER` 后，下一次请求直接按 `VIEWER` 拒绝，无需等待 JWT 过期（`AUTH-02`）；
  - 新建组织独立未建账状态、不复制原组织数据。
- **Commit**：`feat(organization): add OrganizationContextGuard, PermissionGuard, and org CRUD/audit APIs` — `Verified: unit, api`
- **Checkpoint**：跨组织 `404` 不泄露存在性、降权秒级生效、`audit.read` 权限边界全部实测通过。

---

### W18（P2-2）：全量业务只读 GET 端点组织上下文接入与跨组织 404 隔离（`LEDGER-01` 只读部分）
- **目的**：按 `技术方案.md` P2 将所有业务模块的 **GET 只读查询**切为组织范围查询（`{ id, organizationId }`），消除「同组织不同成员看不到他人记录 / 跨组织越权读」。
- **兼容性边界（至关重要）**：
  - 在 `Goal #3B` 与前端全量切完之前，业务 GET 端点（`account`、`plan`、`transaction`、`usage`、`correction`、`report`、`home`、`settings`、`reminder`、`ai` 会话列表/消息只读）支持「有 `X-Organization-Id` 走 `OrganizationContextGuard` 严格校验；过渡兼容窗口仅当请求无 `X-Organization-Id` 且用户**恰好只有 1 个 ACTIVE 默认组织**时映射到唯一组织，若用户拥有 ≥2 个组织或 0 个组织仍严格返回 `400 ORGANIZATION_REQUIRED`（`技术方案.md:362`）」。确保现有 18 个个人 API 测试仍能全绿且多组织零泄露！
  - 注：待 W15 `MIG-B` 已回填旧数据且后续写前先按需保障双写/默认组织回填（新注册/既有测试用户的默认组织由 Helper/注册兜底自动创建，保证单一组织测试场景有 `organizationId`）。
- **改动模块**：
  1. `account`（`GET /accounts`、`GET /accounts/:currencyCode`、`GET /accounts/:currencyCode/transactions`、`GET /accounts/:currencyCode/allocations`）
  2. `plan`（`GET /plans`、`GET /plans/:id`；注意 `PlanAllocation`/`PlanInstallment` 查询校对父 `Plan.organizationId`）
  3. `transaction`（`GET /transactions/:id`）
  4. `usage`（`GET /plans/:planId/usages` 等只读路由）
  5. `correction`（`GET /corrections`、只读查询）
  6. `report`（`GET /reports/plans`、`GET /reports/plans/:id`）
  7. `home`（`GET /home/state`、`GET /home/portfolio`）
  8. `settings`（`GET /settings`：个人展示字段读 `UserSettings`，组织偏好读 `OrganizationSettings` 并回落兼容未迁旧记录）
  9. `reminder`（`GET /reminders`：按当前组织计划事件 + 当前 `actor.userId` 的 `ReminderRead` 计算个人未读态，`LEDGER-03` 只读侧）
  10. `ai`（`GET /ai/conversations`、`GET /ai/conversations/:id/messages`：按 `{ userId: actor.userId, organizationId: actor.organizationId }` 严格隔离）
- **必配测试**：
  - `services/chat/test/integration/organization-read-isolation.spec.ts`：构造 Org A（Owner U1 + Viewer U2）与 Org B（Owner U3、且含部分同 `userId` U1 属双组织），验证：
    1. 同组织 Viewer U2 与 Owner U1 在 Org A 读取到完全一致的账户/计划/交易/使用/更正/报告；
    2. U1 带 Org B 头请求 Org A 的任意记录 ID（Account/Plan/Transaction/Correction/Report/AiConversation）全部返回 `404`；
    3. U1 属 A+B 双组织但不传 `X-Organization-Id` 请求业务 GET → 强制 `400 ORGANIZATION_REQUIRED`（禁猜测默认组织）；
    4. Viewer 被禁用后用旧 JWT 请求全部 GET 端点 → `404 ORGANIZATION_NOT_FOUND`。
  - 既有全部 `test/api/*.spec.ts` 回归通过（0 failed）。
- **Commit**：`feat(read-isolation): scope all business GET endpoints by organizationId` — `Verified: api, integration`
- **Checkpoint**：全量 GET 端点满足「同一组织一致视图 + 跨组织 404 + 多组织缺头 400」。

---

### W19（P3-1）：成员与邀请全生命周期 API（`MEM-01..02`）+ OpenAPI 同步生成
- **目的**：完整实现邀请创建/查详情/接受/拒绝/撤销、成员列表/改角色/禁用、主动退出与 Owner 原子转移，并同步生成 OpenAPI 客户端契约。
- **改动/新建文件**：
  1. `services/chat/src/organization/invitation-rules.ts` & `organization-rules.ts`（纯函数不变量，同目录 `.spec.ts` 单测）：
     - 高熵 token 生成（`randomBytes(32).toString("base64url")`）与单向 SHA-256 `tokenHash` 存库（原始 token 仅在创建响应/邮件中出现一次，绝不进数据库和审计详情）；
     - 邮箱规范化（`email.trim().toLowerCase()`）；7 天有效期校验；同一 `(organizationId, normalizedEmail)` 存在有效未过期/未接受/未拒绝/未撤回邀请时幂等返回既有有效记录（或显式返回当前有效状态）；
     - `canManage(actorRole, targetRole, action)`：Admin 不能邀请/提升/修改/移除 Owner；Owner 不能直接自降（须走转移）；最后 Owner 禁止退出/移除。
  2. `services/chat/src/organization/member.controller.ts` & `invitation.controller.ts`（或拆分 Service，严格在 `organization/` 目录内）：
     - `GET /api/organizations/current/members`（`member.read`）
     - `PATCH /api/organizations/current/members/:id`（`member.update`，同事务写 `AuditLog`）
     - `DELETE /api/organizations/current/members/:id`（`member.remove`，设为 `DISABLED` 保留历史归属 + 同事务写 `AuditLog`）
     - `POST /api/organizations/current/members/leave`（成员主动退出；最后 Owner 拒绝并返回 `409 LAST_OWNER_REQUIRED`）
     - `POST /api/organizations/current/invitations`（`member.invite`，禁邀 `OWNER`）
     - `GET /api/organizations/current/invitations`（`member.read` 查当前待处理邀请列表，不回吐 `tokenHash`）
     - `DELETE /api/organizations/current/invitations/:id`（`member.invite` 撤回）
     - `GET /api/organization-invitations/:token`（登录个人端点：返回脱敏摘要：组织名、角色、邀请人展示名、过期时间、状态；**不含任何账户余额或业务明细**）
     - `POST /api/organization-invitations/:token/accept`（登录用户 + 邮箱规范化严格匹配 → 事务内消费邀请 + upsert/恢复原 `DISABLED` Membership + 写 `AuditLog`；并发双抢由事务/条件更新保证仅 1 个有效 Membership）
     - `POST /api/organization-invitations/:token/decline`（登录用户 + 邮箱匹配 → 标记拒绝）
     - `POST /api/organizations/current/transfer-ownership`（`owner.transfer`：事务内将 target 升级为 `OWNER`、原 Owner 降为 `ADMIN` 并写审计，受 `memberships_single_active_owner_uidx` 约束与先降后升顺序保护——先将原 Owner 暂改目标角色或按约束安全顺序更新！**注意部分唯一索引更新顺序**：同一事务中**必须先把原 Owner 改为 `ADMIN`，再把新 Owner 改为 `OWNER`**，否则中间态触发唯一索引冲突！）
  3. 补全全部控制器 `@ApiExtraModels` / `@ApiOkResponse` / `@ApiCreatedResponse` / `@ApiOperation`，运行 `bun run --cwd clients/chat-web generate:api` 刷新 `openapi.json` 与 `schema.gen.ts`（双跑验证 SHA-256 零 diff）。
- **必配测试**：
  - `services/chat/src/organization/organization-rules.spec.ts` & `invitation-rules.spec.ts`（覆盖所有边界态）
  - `services/chat/test/api/membership.spec.ts` & `services/chat/test/integration/organization-lifecycle.spec.ts`：
    - 邀请创建/幂等复用/错邮箱拒绝/过期/撤回/接受后重放拒绝/并发接受单 Membership；
    - Admin 越权管 Owner 拒绝；
    - 被禁用成员重新获邀可恢复且历史记录操作者不丢；
    - 所有权转移事务顺序验证（不撞部分唯一索引）、转移后新 Owner 权限立即生效且原 Owner 降为 Admin；
    - 最后 Owner 退出报 `409 LAST_OWNER_REQUIRED`。
- **Commit**：`feat(membership): add invitation state machine, member RBAC, ownership transfer, and OpenAPI` — `Verified: unit, api, integration`
- **Checkpoint**：并发接受、唯一索引顺序、错误邮箱、最后 Owner 保护、OpenAPI 0 diff 全绿。

---

### W20（P3-2）：前端组织上下文底座（`organization-store` / `apiClient` 头注入 / `queryKeys` 组织隔离 / `useOrganizations`）
- **目的**：按 `技术方案.md` §10.1 落地前端可切换组织上下文，杜绝切组织缓存串联、迟到响应覆盖或客户端权限篡改。
- **改动/新建文件**：
  1. `clients/chat-web/lib/stores/organization-store.ts`（zustand + persist 仅存 `activeOrganizationId: string | null`，**严禁持久化 `role` 或 `capabilities`**）。
  2. `clients/chat-web/lib/api/organizations.ts`（基于 `schema.gen.ts` `Schemas["..."]` 薄别名，零手写 DTO）。
  3. `clients/chat-web/lib/api/query-keys.ts`：
     - 启用 W10 预留的 `withOrgScope`：组织作用域 query keys 统一带上 `orgId`（如 `queryKeys.accounts.all(orgId)` / 传入可选/必填 `orgId`），更新 W10 `[Nit]` 记录的 `invalidateAfterLedgerMutation` / `invalidateAfterOnboarding` 支持传入 `orgId`；
     - 新增 `queryKeys.organizations.*`、`queryKeys.members.*`、`queryKeys.auditLogs.*` 与组织切换失效助手 `clearOrganizationScopedQueries(queryClient)`（先 `cancelQueries` 中止在途旧组织请求，再 `removeQueries` 清除非公共汇率缓存，防止迟到响应回写新组织页！）。
  4. `clients/chat-web/lib/api/client.ts` & `clients/chat-web/lib/api/chat.ts`：
     - 非个人/公共端点统一读取当前选中 `activeOrganizationId` 自动注入 `X-Organization-Id` 请求头（`chat.ts` 的 SSE `openStreamResponse` 与所有导出下载 fetch 路径同样注入）；
     - 显式处理 `400 ORGANIZATION_REQUIRED`（清失效选择并触发组织选择路由）、`404 ORGANIZATION_NOT_FOUND`（清旧组织缓存与选中态，跳转受保护组织选择/无权限引导）、`403 PERMISSION_DENIED`（区分预期权限提示，不触发注销退出）。
  5. `clients/chat-web/lib/hooks/use-organizations.ts` & `clients/chat-web/lib/hooks/use-organizations.spec.tsx`：
     - 拉取 `GET /api/organizations` 与 `GET /api/organizations/current`；提供 `switchOrganization(nextOrgId)`（Abort + cancel + remove + 切 store + invalidate）。
  6. 同步全仓调用 `queryKeys` 的 hooks（`use-home-state`、`use-plan-list`、`use-data-request`、`use-reminders`、`use-conversations` 等）绑定 `activeOrganizationId`（`enabled: Boolean(activeOrganizationId)`，确保未选组织前不乱发带空头业务请求，与 W10 降噪一脉相承）。
- **必配测试**：
  - `clients/chat-web/lib/hooks/use-organizations.spec.tsx`（单组织直连、多组织切换触发 `cancelQueries` + `removeQueries`、迟到慢响应不污染新组织缓存、服务端 `404 ORGANIZATION_NOT_FOUND` 失效态清理）；
  - `clients/chat-web/lib/api/client.spec.ts`（注入 `X-Organization-Id`、400/404/403 处理、`401` 清理 token）；
  - `clients/chat-web/lib/api/query-keys.spec.ts`（A/B 组织 key 完全正交不碰撞）。
- **Commit**：`feat(web): add organization context store, X-Organization-Id transport, and org-scoped Query Keys` — `Verified: unit`
- **Checkpoint**：`test web` 全部通过；`bun run lint && bun run typecheck` 无新裸 `useEffect` 与零影子 DTO。

---

### W21（P3-3）：前端组织工作台 UI、路由分流、成员/邀请/审计页（`ORG-00..03`, `MEM-01..02`, `AUDIT-03`）
- **目的**：按 `需求文档.md` §13 & `技术方案.md` §10.2 完成前端 R1 组织工作台全部只读与成员/组织管理界面。
- **改动/新建文件**：
  1. `clients/chat-web/components/business/organization/`（带 `index.ts` 桶文件，严格遵守 `business → base → ui`，无裸 `useEffect` / `setTimeout`）：
     - `organization-switcher.tsx`（顶栏切换器 + 单组织简化态显示 + 加载过渡锁防新旧数据混显）
     - `organization-picker.tsx`（多组织选择卡 / 无有效组织新建引导）
     - `organization-form.tsx`（新建组织 / 改名表单）
     - `member-table.tsx` & `role-select.tsx`（角色调整、禁用确认、`OWNER` 保护提示）
     - `invite-form.tsx` & `invitation-list.tsx`（发邀请、复制链接、撤销，含服务端 `capabilities` 控制显隐）
     - `transfer-ownership-dialog.tsx`（高危二次确认）
  2. `clients/chat-web/components/business/audit/`（带 `index.ts` 桶文件）：`audit-log-table.tsx`、`audit-filter.tsx`（分页 + 时间/成员/动作筛选，严格仅对具备 `audit.read` capability 的成员展示入口，无编辑/删除操作）。
  3. 路由与布局：
     - `clients/chat-web/app/(protected)/layout.tsx`：接入 `useOrganizations`；单组织直达、多组织先选或切、无组织引导创建；顶栏渲染 `OrganizationSwitcher`；保留既有 `ComplianceDisclaimer`；组织上下文未就绪前隔离渲染加载态（`ORG-02.4` / §10.1）。
     - `clients/chat-web/app/(protected)/organization/page.tsx`（组织信息、入口导航）
     - `clients/chat-web/app/(protected)/organization/members/page.tsx`（成员管理、邀请、所有权转移、主动退出）
     - `clients/chat-web/app/(protected)/organization/audit/page.tsx`（审计分页页面，无权角色显示明确无权限提示）
     - `clients/chat-web/app/(protected)/invitations/[token]/page.tsx`（受邀摘要展示与接受/拒绝；验证未登录跳转 `/login?redirect=...` 完成后回跳接受）
     - 更新 `clients/chat-web/app/login/page.tsx` & `register/page.tsx` 团队协作定位文案（不展示任何业务明细，保留既有 OTP/条款确认流程）。
- **必配验证**：
  - `PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run test web`
  - `bun run lint && bun run typecheck`（验证 0 裸 `useEffect`、0 `setTimeout`、0 反向组件依赖、0 影子 DTO）
  - `PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run build`（验证所有新路由构建成功、Next.js App Router 无 SSR/CSR 边界错误）
  - **补充 E2E 用例草稿**（本阶段写好用例文件并待人类启服验收，或在 `Goal #3C` 全量扩充）：在 `e2e/modules/` 起草组织创建、切换与邀请成员端到端测试骨架或标记待人类启服后运行范围。
- **Commit**：`feat(web): implement organization switcher, member/invitation management, and audit UI` — `Verified: unit, diff`

---

## 4. 全量验证门禁与独立对抗审（Goal #3A 收口必过）

1. **Diff 触发检查**：`git diff --name-only dev...HEAD`，对照 `docs/VERIFY.md` §2 核对 Prisma DDL/回填、Guard/RBAC 鉴权、OpenAPI、前端 hooks 全命中项；验证 `bun run --cwd clients/chat-web generate:api` 输出零 git diff。
2. **L1 静态与单元**：
   - `bun run check:structure`
   - `bun run lint`（新增文件 0 warning/0 error）
   - `bun run typecheck`
   - `PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run test unit web scripts money dev-log`
3. **L2 数据库与接口/集成**：
   - `bun run db:status`
   - `bun run test api integration infra`（重点包含 `organization.spec.ts`、`membership.spec.ts`、`audit.spec.ts`、`organization-read-isolation.spec.ts`、`organization-migration.spec.ts` 及全量既有个人 API 0 回归）
   - `PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run build`
4. **L3 探活 / 人类 E2E 交接**：按 `AGENTS.md` AI 不启服；若人类已启服运行相关 Playwright 并清理 `e2e/test-results/`，否则标注 `NOT_RUN` 并列出明确人工 E2E 跑测清单。
5. **独立对抗审（D6）**：优先 Codex CLI 只读审查，不可用降级为独立只读 `research` 子智能体，重点围堵：**跨组织 404 不漏存在性**、**部分唯一索引转移所有权事务顺序**、**`tokenHash` 不明文落库/不进日志**、**降权秒级生效不读旧 JWT 角色**、**前端切换缓存不串联**、**无未授权目录/裸 `useEffect`**。全部 `[Important]` 必须清零。

---

## 5. 提交、交接与 Goal #3B 准入门输出

- `.changeset/tob-r1-a-foundation-read-members.md`（记录 R1-A 增量）
- push `feat/tob-r1-a-foundation-read-members` → 创建 **Draft PR** 到 `dev`（严禁 merge / ready）
- 生成 `docs/handoff/OVERNIGHT-TOB-R1-A-YYYYMMDD.md`，必须包含：
  1. W13–W21 Commit 清单、PR 链接、改动范围与 `AGENTS.md` 目录变更记录；
  2. `MIG-B` 回填 + §12.3 核对 CLI 在备份副本实跑 0 差异证据（含反复幂等日志）；
  3. 跨组织 API 隔离与权限测试结果、L1/L2/L3 验证矩阵；
  4. 独立对抗审方式（Codex CLI 或降级说明）与 `[Important]`/`[Nit]`/`[Pre-existing]` 闭环状态；
  5. **Goal #3B 启动准入核对**：明确哪些老代码仍依赖「单默认组织兼容窗口」（待 `Goal #3B` 切写操作与拆 `DataRequest` 时关闭）。
