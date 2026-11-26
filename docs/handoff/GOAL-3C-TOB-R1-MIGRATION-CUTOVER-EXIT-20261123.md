# Goal #3C — FXplannerREBUILD · ToB R1 迁移核对、约束收紧与 R1 退出门（P6）

> 适用阶段：Phase 3 · ToB R1 Part C（对应 `技术方案.md` P6：`MIG-C` 双写一致性核对 → `MIG-D/E` 移除兼容性猜想、非空/唯一约束收紧、解除 `User` 级联防误删 → `MIG-F` 废弃列与老代码清理 + 全量跨租户矩阵 + R1 E2E 闭环 + R2 准入门）
> 接力序列：`Goal #3A (P1–P3)` → `Goal #3B (P4–P5)` → **`Goal #3C (W29–W32)`** → `Goal #4 (ToB R2 Agent)`
> 前置门控：**必须在 Goal #3A 与 Goal #3B 均已合入 `dev`，且本地已备好完整个人+多组织混合样本备份库副本以供 `MIG-A→F` 全流程演练后启动**
> 上游真源：`AGENTS.md`、`docs/VERIFY.md`、`changes/tob-agent-workspace/需求文档.md`（§12, §14, §15.1–§15.3, §15.5, §16）、`changes/tob-agent-workspace/技术方案.md`（§4.4, §5.2–§5.3, §7.3, §12, §14, §15.1–§15.3, §17）、`docs/handoff/OVERNIGHT-TOB-R1-B-YYYYMMDD.md`
> 建议特性分支：`feat/tob-r1-c-migration-cutover-exit`

---

## 1. 背景与开工前只读硬门核验

- 仓库：`/Users/kyle/Documents/工作/知爻/FXplannerREBUILD`
- 开工核验 checklist：
  1. `git fetch origin && git status -s`：确认 `dev` 已包含 Goal #3A & #3B 全部提交并干净。
  2. 核对 `docs/handoff/OVERNIGHT-TOB-R1-B-YYYYMMDD.md`：确认 P4/P5 共享账本、同事务审计、`PERSONAL`/`ORGANIZATION` 数据请求双锁全部 0 failed。
  3. 备库核查：使用独立临时库/备份副本（严禁在 `fxplanner_new_db_local` 盲跑破坏性测试后再找不到回滚对照），按 `技术方案.md` §12.4 记录核对与不可逆阶段（`MIG-E` 之后）边界。
  4. 切出分支：`git checkout -b feat/tob-r1-c-migration-cutover-exit dev`。

---

## 2. 分支、自治与不可逆操作红线

- **Git 自治边界（D7）**：仅在 `feat/tob-r1-c-migration-cutover-exit` 内完成 W29–W32，push 特性分支并创建 **Draft PR** → `dev`。**严禁** push/merge `dev`/`main`、**严禁**转 Ready、**严禁**在生产环境直接跑迁移（仅本地与测试/备份库演练）。
- **服务禁令**：按 `AGENTS.md` 禁止启动 dev 服务；W31 编写的 `e2e/modules/15-organization.spec.ts` 由人类启动前后端后运行，取证完清理 `e2e/test-results/`。
- **不可逆操作保护**：`MIG-E` 收紧 `NOT NULL` 与清理过渡部分唯一索引（唯一约束已在 Goal #3B W22 提前切至组织维度）前，**必须先跑通 `MIG-C` §12.3 零差异核对脚本与父子 `organizationId` 一致性断言**；任何 1 条异常行未处理禁止强行上收紧迁移。

---

## 3. 原子级垂直切片清单（W29–W32）

### W29（P6-1 / `MIG-C` + 确定性防越权静态守卫）：全仓零越权静态门禁与全量一致性核对演练
- **目的**：按全局工程规则 #3 与 `技术方案.md` §4.4、§12.3、§18 第 1 条风控，把「Service 层不能漏写 `organizationId` 过滤而退化成按 `userId`/裸 `id` 查表」固化为确定性自动化门禁脚本，并在完整迁移演练中跑出 0 差异证据。
- **改动/新建文件**：
  1. `scripts/check-org-scope.ts` + `scripts/__tests__/check-org-scope.spec.ts` + 接入根 `package.json` `lint` 或 `check:structure` 链路：
     - 扫描 `services/chat/src/{account,plan,transaction,usage,correction,report,reminder,home,onboarding,audit,data-request}/` 与 `ai/`：
       - 拦截未标注白名单豁免注释（`// @org-scope-exempt: <明确理由>`，仅限公开字典/个人认证/迁移脚本等合法例外）却直接对业务模型（`account`/`transaction`/`initialHolding`/`costLot`/`plan`/`usageRecord`/`correction`/`reminder`/`organizationSettings`/`aiConversation`）调用 `findUnique({ where: { id } })` / `update({ where: { id } })` / `delete({ where: { id } })` 的裸 ID 查询；
       - 拦截业务模块 Service 在导出符号与 Prisma `where` 中残余仅按 `userId` 查共享账本表（而非 `organizationId` / `createdById`）；
     - 完成「全仓正向通过 + 构造违规片段负向拦截（exit 1）」双重反证测试。
  2. 完善 `services/chat/src/organization/organization-reconcile.ts` 与 `services/chat/prisma/tob-r1-migration/` CLI 核对项：
     - 补充混合迁移前/后快照比对（`MIG-A -> MIG-B -> MIG-C`）：按用户/默认组织核对全部 7 类口径（余额、计划/分配/已用/批次、交易/使用/更正计数版本总额、CostLot `remainingQty`/`unitCost` 与 `UsageLotAllocation`、报告输出一致、组织设置与起点、100% 派生行 `child.organizationId === parent.organizationId`）；
     - 迁移日志仅打印摘要或写受控临时测试目录并清理，严禁写入根目录/产物目录。
- **必配测试**：
  - `scripts/__tests__/check-org-scope.spec.ts`（正向/负向/白名单注释语法测试）；
  - 扩充 `services/chat/test/integration/organization-migration.spec.ts` 完整覆盖混合并发写入后的 §12.3 零差异与孤儿派生行阻断断言。
- **Commit**：`chore(guard,migration): add deterministic org-scope static check and MIG-C parity drill` — `Verified: unit, integration, diff`
- **Checkpoint**：`check-org-scope` 正/负向双过；`MIG-C` 备份库对账 0 差异。

---

### W30（P6-2 / `MIG-D` + `MIG-E` + `MIG-F`）：移除过渡兼容猜想、约束收紧、解除 `User` 级联与废列清理
- **目的**：正式完成 `MIG-D → E → F` 收口，彻底删除过渡期兼容猜想与旧字段，并解除组织账本表对 `users.id` 的级联删除绑定（**确保 `PERSONAL DELETION` 在数据库层面也不可能误级联企业账本**，`技术方案.md` §5.3 #4–5）。
- **前置确认**：先执行一遍 `MIG-B` + §12.3 核对全绿，再编写本切片迁移！
- **改动/新建文件**：
  1. `services/chat/src/authorization/guards/organization-context.guard.ts` & 前端兼容分支（`MIG-D`）：
     - 彻底关闭「无 `X-Organization-Id` 时猜单默认组织」的过渡兼容分支——所有组织业务端点未带合法 `X-Organization-Id` 统一返回 `400 ORGANIZATION_REQUIRED`（个人端点 `/auth/*`、`/organizations`、`/organization-invitations/:token`、`/currencies`、`/rates` 不变）；
     - 修复全部既有 `services/chat/test/api/*.spec.ts` 与 `test/integration/*.spec.ts` 的共享测试夹具（`services/chat/test/helpers/`），确保测试用户默认创建组织后所有业务请求显式携带 `X-Organization-Id`（**严禁**在 spec 间复制助手，只改共享 `test-app.ts` / `helpers/`）。
  2. Prisma Schema + 两步清晰迁移（或按 `MIG-E` / `MIG-F` 分两份独立可审 Migration SQL）：
     - **Migration `MIG-E`（`<ts>_tob_r1_mig_e_tighten_constraints`）**：
       - 将 10 张业务表（`accounts`, `transactions`, `initial_holdings`, `cost_lots`, `plans`, `plan_change_logs`, `usage_records`, `corrections`, `reminders`, `ai_conversations`）与 `data_requests` 对应字段收紧：`organization_id SET NOT NULL`（`data_requests.organization_id` 保持由 `CHECK` 控制的可空）；
       - **唯一约束与过渡索引收口说明**：`Account`、`InitialHolding`、`Reminder` 的组织维度唯一约束（`@@unique([organizationId, currencyCode])`、`@@unique([organizationId, dedupKey, scheduledFor])`）已在 Goal #3B W22（`20261125094500_tob_r1_mig_c_org_unique_indexes`）提前切换；本步 `MIG-E` 使用 `DROP INDEX IF EXISTS` 清理过渡期部分唯一索引（`accounts_legacy_user_currency_uidx`、`initial_holdings_legacy_user_currency_uidx`、`reminders_legacy_user_dedup_scheduled_uidx`）与冗余非唯一 `(user_id, ...)` 查找索引（`accounts_user_id_currency_code_idx`、`initial_holdings_user_id_currency_code_idx`、`reminders_user_id_dedup_key_scheduled_for_idx`）；
       - 收紧 `created_by_id` / `actor_user_id` 外键为 **`ON DELETE SET NULL`**，并**移除 `User` 与上述组织共享业务表之间原有的 `onDelete: Cascade` 外键**（改为 `Account`/`Plan`/`Transaction`/`InitialHolding`/`CostLot`/`UsageRecord`/`Correction`/`Reminder` 等直连 `Organization` `onDelete: Restrict` 或显式事务删组织清理，`PlanChangeLog` 等保留 `Plan` CASCADE；`OtpIdentity`、`TermsConsent`、`UserSettings`、`PERSONAL` `DataRequest`、`ReminderRead`、`AiConversation` 保留随个人适当清理策略）；
       - 注意 `Account.userId`、`Plan.userId` 等旧 `userId` 列先确认零生产引用后再进 `MIG-F` 删除。
     - **Migration `MIG-F`（`<ts>_tob_r1_mig_f_drop_legacy_columns`）**：
       - 删除已迁空且静态确认零生产引用的旧列：`UserSettings.{baseCurrency, prepPreference, reminderEnabled, ledgerStartedAt}`、`Reminder.readAt`、以及业务共享表上确认不再保留的冗余 `userId`（`Account`/`InitialHolding`/`Transaction`/`CostLot`/`Plan`/`UsageRecord`/`Correction`/`Reminder` 等——以 `createdById`/`actorUserId` 为唯一作者列，`Membership` 移除与个人注销永不级联删企业账本；`DataRequest` 的原 `userId` 重命名/明确为 `requesterUserId` 保留 `ON DELETE SET NULL` 或按 `PERSONAL`/`ORGANIZATION` 约束处理）。
  3. **性能回归与索引实测（§14.5）**：
     - 在 100+ 组织 × 1,000+ 账本行副本上对核心列表与 Membership 鉴权查询运行 `EXPLAIN (ANALYZE, BUFFERS)`（验证走 `organization_id` 开头索引、零 `Seq Scan`）并记录同数据量迁移前后 **P50/P95 响应对比**（写入交接报告）。
  4. **存量 ESLint 8 处 Error 收口评估**（Goal #2 backlog）：顺带清零 `services/chat` 6 处 + `clients/chat-web` 2 处存量 `no-unused-vars` error（仅清理死 import/死变量，不扩大业务重构），并记录 `lint:observe` 是否具备在下一阶段转 `enforce` 的条件。
- **必配测试**：
  - `services/chat/test/prisma.spec.ts`：更新 M0/R1 冻结基线测试（验证不同 User 在同组织建同币种 `Account` 唯一冲突生效，不同组织可各建同币种 `Account`；`User` 删除不级联删除 `Account`/`Plan`/`Transaction`）；
  - 全量 `api` + `integration` + `infra` + `unit` + `web` + `money` + `dev-log` + `scripts`（全部 0 failed）；
  - 在**独立备份副本库**完整顺序跑一遍 `MIG-A → MIG-B → MIG-C → MIG-E → MIG-F` + §12.3 校验全通并留存日志。
- **Commit**：`feat(migration): enforce MIG-D/E/F constraints, decouple User cascade, and clean legacy columns` — `Verified: unit, api, integration, infra, diff`
- **Checkpoint**：备份库完整顺序迁移 + 全量测试 0 failed；`EXPLAIN` 与 P50/P95 实测留档。

---

### W31（P6-3）：全量跨租户 API 参数化矩阵测试 & ToB R1 E2E 用例（`e2e/modules/15-organization.spec.ts`）
- **目的**：按 `需求文档.md` §15.1–§15.3, §15.5 与 `技术方案.md` §14.2, §14.4 补齐全覆盖端到端与参数化 API 防线（不留只隐藏按钮的 UI 假验收）。
- **改动/新建文件**：
  1. `services/chat/test/api/organization-matrix.spec.ts`：
     - 参数化遍历全部业务控制器端点（`account` / `plan` / `transaction` / `usage` / `correction` / `report` / `reminder` / `settings` / `onboarding` / `organization` / `members` / `invitations` / `audit` / `data-requests` / `ai`）：
       - 无 token → 401
       - 缺失 `X-Organization-Id` → 400 `ORGANIZATION_REQUIRED`
       - 非成员组织 ID → 404 `ORGANIZATION_NOT_FOUND`
       - `DISABLED` 成员 → 404 `ORGANIZATION_NOT_FOUND`
       - `VIEWER` / `OPERATOR` 调各自禁写端点 → 403 `PERMISSION_DENIED` + 零数据变更 + `AuditLog(DENIED)` 记录
       - 用 Org B 合法记录 ID 请求 Org A（详情/改/删/预览/导出）→ 统一 404
       - 降权后旧 JWT 立即按新角色拦截
       - 最后 Owner 退出/降权/个人注销 → 409 `LAST_OWNER_REQUIRED`
  2. `e2e/modules/15-organization.spec.ts`（并检查 `e2e/helpers/`）：完整覆盖 R1 GWT 验收标准：
     - GWT-1..5：存量默认组织升级视图、新建组织 B 隔离与独立建账、A/B 切换一致性 + **延迟响应防篡改（用 Playwright 路由拦截模拟 A 慢响应迟于 B 响应，断言页面仍显示 B 不被覆盖！`ORG-02` / GWT-4）**、最后 Owner 保护；
     - GWT-6..14：邀请接受（含未登录带链接跳转登录再回跳接受）、错邮箱/过期/撤回/重放拒绝、5 角色关键路径、Operator 建计划可 & 记买入拒、Viewer 越权提示、成员移除旧会话刷新失效、Owner 转移后原 Owner 降 Admin；
     - GWT-15..18：Finance A 录入后 Operator 刷新同视图、并发更正版本冲突提示、组织级 `USAGE` 更正端到端闭环、双成员个人已读互不清除；
     - GWT-26..30：Org A 清空不影响成员其他组织、最后 Owner 个人注销受阻与引导、组织导出后被移出不可下载、审计日志完整展示且无改删入口。
     - 更新既有 `e2e/modules/01~14` 受影响夹具/头配置（若有因 W30 关闭单组织猜想需登录建默认组织或带头）。
- **验证**：
  - `bun run --cwd services/chat test test/api/organization-matrix.spec.ts` 全绿；
  - `bun run typecheck && bun run lint`（含 Playwright ts 检查）；
  - 将全量 `e2e/modules/` 跑测指令清晰列于交接（若人类已启服则实跑并清理 `e2e/test-results/`，否则标注 `NOT_RUN` 交由人类跑全量 E2E 验收）。
- **Commit**：`test(tob-r1): add parameterized cross-tenant API matrix and 15-organization E2E suite` — `Verified: api, diff`（若跑过 E2E 则附 `e2e`）

---

### W32（P6-4）：验收文档落盘（`验收记录.md`）、文档同步与 R2（Goal #4）准入门封箱
- **目的**：严格遵守 `技术方案.md` §15.3 & `AGENTS.md`：只有在全部实际测试跑完后，才编写 `changes/tob-agent-workspace/验收记录.md` 并刷新仓库长期文档，**严禁以方案文档充当验收证据**。
- **改动/新建文件**：
  1. `changes/tob-agent-workspace/验收记录.md`：逐条对账 `需求文档.md` §17 与 `技术方案.md` §17 需求—设计—测试追踪表（`ORG-01..03`、`MEM-01..02`、`AUTH-01..02`、`LEDGER-01..04`、`AGENT-01`、`AUDIT-01..03`、`DATA-01..02`、`MIG-01`，**标明 `AGENT-02..04` 留待 R2 / Goal #4**），附真实运行命令、退出码、文件/用例计数及回滚/运维边界。
  2. 同步刷新 `README.md` 与 `docs/FEATURE-MAP.md`（新增 ToB 组织/成员/审计/双域数据权利功能地图与对应验证命令）。
  3. 检查 `docs/handoff/GOAL-4-TOB-R2-AGENT-YYYYMMDD.md` 是否需作为后续接力输入清单，在交接报告末尾明确 **ToB R2 启动准入门**：
     - P0–P6 全量 L1/L2/L3（含 `15-organization.spec.ts` 与 `T-CORR-004`）0 failed；
     - `check-org-scope` 0 违规；
     - 独立对抗审 0 `[Important]`。
- **Commit**：`docs(tob-r1): add acceptance report, feature map updates, and Goal #4 R2 readiness gate` — `Verified: unit, api, integration, infra, diff`（若人类跑过 E2E 含 `e2e`）

---

## 4. 全量验证门禁与独立对抗审

1. **全量 L1 + L2 + `build`**：
   - `bun run check:structure && bun run lint && bun run typecheck`
   - `PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run test unit web scripts money dev-log`
   - `bun run db:status && bun run test api integration infra`
   - `PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run build`
2. **全量 L3 E2E（人类启动服务后全量 `bun run test:e2e`，0 failed 后清理 `rm -rf e2e/test-results`）**。
3. **独立对抗审（D6）**：重点审计：`check-org-scope` 是否存在静态规则绕过洞、SQL `ON DELETE` 迁移是否有级联误删企业账本风险、旧单组织猜想是否已 100% 清除、并发权限/跨租户参数矩阵是否有遗漏接口、E2E 是否有伪断言/`sleep`/`skip`。全部 `[Important]` 必须清零。

---

## 5. 提交、交接与 R1 退出 / R2 启动输出

- `.changeset/tob-r1-c-migration-cutover-exit.md`
- push `feat/tob-r1-c-migration-cutover-exit` → **Draft PR** → `dev`（严禁 merge / ready）
- 生成 `docs/handoff/OVERNIGHT-TOB-R1-C-YYYYMMDD.md`，必须包含：
  1. W29–W32 Commit 清单与 Draft PR 链接；
  2. 独立备份库 `MIG-A → F` 全链路执行日志、§12.3 零差异核对摘要、`EXPLAIN (ANALYZE, BUFFERS)` 与迁移前后 P50/P95 数据；
  3. L1/L2/L3 全量计数、ESLint 存量清零统计与 `check-org-scope` 正负向反证结果；
  4. 独立对抗审记录；
  5. **ToB R1 发布门 & Goal #4（P7–P8 组织只读/草稿 Agent）启动签字项**。
