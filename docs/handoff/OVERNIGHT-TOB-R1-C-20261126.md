# Goal #3C Overnight Handoff：ToB R1 迁移切换（MIG-C..F）、跨租户全矩阵与 R1 退场验收（W29–W32）

- **目标文档**：[GOAL-3C-TOB-R1-MIGRATION-CUTOVER-EXIT-20261123.md](./GOAL-3C-TOB-R1-MIGRATION-CUTOVER-EXIT-20261123.md)
- **分支与基准**：`feat/tob-r1-c-migration-cutover-exit`（切自 `dev` `ccc63bd` / PR #11）→ **Draft PR → `dev`**（严禁合并或标 Ready）
- **调度与工具回退审计实录**：
  - 初期按「总指挥 + ZCode / MiniMax Code 并行 worktree」策略调度，但 ZCode (`GLM-5.4 高`) 在 `wt-w29-guard` 与 `wt-w30-perf` 两次连续卡死 >15 分钟零产出（依 15 分钟掉线规则停机转派）；
  - MiniMax Code (`M3.1-Flash high`) 顺利交付 W29-Part2 并在 `wt-w30-migef` 完成核心切换后触发「5 小时对话用量已达上限」（继续请求将消耗积分），当即停用以保护额度，由 Antigravity `self` / `research` 子代理与主控终端校验无缝接管完成 W30 收口、W31 与 W32。

---

## 1. W29–W32 Commit 清单与交付定位

| 批次 | Commit SHA | 提交说明 | 关键交付与对抗审门禁 |
| --- | --- | --- | --- |
| W29 | `964ea00` | `chore(guard,migration): add deterministic org-scope static check and MIG-C parity drill` | `scripts/check-org-scope.ts`（`ts-morph` AST + 正/负反证 `15/15`）、`migration-schema-capabilities.ts`、`organization-migration-snapshot.ts`；Track 1A (`5ff459d3`) 与 Track 1B (`4907f623`) R2 均 `Important count: 0` |
| W30 | `2c7bd68` | `feat(migration,auth): complete MIG-D/E/F cutover and P6 benchmark` | 删 `BusinessOrgScopeGuard` 与兼容回退、登录分流 `post-login-target.ts`、`MIG-E`/`MIG-F` SQL、空组织回收修复、闭环 AST 旁路、`prisma.spec.ts` 真 `23502` 校验、`benchmark-p6.ts`；R2 (`457e97a9`) `Important count: 0` |
| W31 | `abf8f2c` | `test(api,e2e): add 409-case org matrix and expand 15-organization E2E` | `organization-matrix.spec.ts` (**409/409** 通过，16 域 + 37 条 `2c` 无头 400 + 列表读隔离 + 组织锁隔离）、`e2e/modules/15-organization.spec.ts`（32 条 `GWT-1..18, 26..30`）与 `e2e/helpers/{org-scope,organization-db}.ts`；矩阵 R2 (`f4826f99`) 与 E2E R2 (`76d46745`) 均 `Important count: 0` |
| W32 | （随本文件一同提交） | `docs(tob-r1): add acceptance report, feature map updates, and Goal #4 readiness gate` | `changes/tob-agent-workspace/验收记录.md`、`README.md`、`docs/FEATURE-MAP.md`、`AGENTS.md`、`.changeset/tob-r1-c-migration-cutover-exit.md`、本文档及全分支 `D6` 对抗审 |

---

## 2. `MIG-A..F` 迁移全链路、§12.3 零差异与 P6 性能实证

- **备份路径**：`/tmp/fxplanner_new_db_local_pre_goal3c.sql`（切换前全库逻辑备份；已清理 3 个临时 `_test` 克隆库）。
- **回填与 `MIG-E`/`MIG-F` 切换实测**（`fxplanner_new_db_local`）：
  - `MIG-B --apply --confirm-backup-target`：`usersProcessed=621`、`organizationsCreated=378`、`ownerMembershipsCreated=378`、`organizationSettingsCreated=356`、`reminderReadsCreated=8`、`chunksCommitted=13`。
  - 切换前 `psql` 校验 10 张业务表 `organization_id IS NULL` = **`0`**；`prisma migrate deploy` 应用 `20261126190000_tob_r1_mig_e_tighten_constraints` 与 `20261126191000_tob_r1_mig_f_drop_legacy_columns` 一次通过；`prisma migrate status` 显示 `Database schema is up to date!`，`prisma migrate diff --exit-code` 退出 `0`（`No difference detected.`）。
- **`P6` 迁移前/后基准对比**（`fxplanner_w30_perf_test`，120 组织 × 10 行/组织，每表合计 1,200 行，20 预热 + 100 次采样，`zeroResidueVerified: true`）：
  - 8/8 核心查询全部命中 `organization_id` 打头索引，**`0 Seq Scan`**；
  - `EXPLAIN (ANALYZE, BUFFERS)` 单次执行耗时 `0.008–0.014 ms`，P50 `0.0775–0.0972 ms`（切换前 `0.0762–0.0959 ms`），P95 `0.0881–0.1279 ms`（切换前 `0.0928–0.1466 ms`）。完整逐表对比表见 [验收记录.md](../../changes/tob-agent-workspace/验收记录.md)。

---

## 3. Final Gate 全量结果（`abf8f2c` 实测）

- **裁判基线**：`git diff dev -- eslint.config.mjs docs/VERIFY.md scripts/check-structure.ts` = **空**。
- **L1 静态与契约**：
  - `check:structure` exit 0；
  - `check:org-scope` exit 0（扫描 `62` 文件，`0` 违规；`scripts/__tests__/check-org-scope.spec.ts` **16 pass, 0 fail** 含可变 `let`/类型别名遮蔽/强转 `OrganizationLedgerScope` 负向反证）；
  - `lint` exit 0（`lint:observe`：`clients/chat-web` 261 文件 `0 errors, 15 warnings`；`services/chat` 275 文件 `0 errors, 59 warnings`）；
  - `typecheck` exit 0（Turbo 4/4）；`generate:api` ×2 SHA-256 零漂移（`openapi.json` `1dbec227...`，`schema.gen.ts` `6ecf330f...`）；`build` exit 0（NestJS + Next.js 16.2.3 21 路由）。
- **L1+ & L2 测试全绿**：
  - `unit`: 50 文件 / **`740 passed | 1 todo (741)`**
  - `web`: 36 文件 / **`432 passed`**
  - `money`: 4 文件 / **`64 passed`**
  - `dev-log`: 4 文件 / **`31 passed`**
  - `scripts`: **`24 pass, 0 fail`**
  - `api`: 22 文件 / **`849 passed`**（含 `organization-matrix.spec.ts` **409/409**）
  - `integration`: 18 文件 / **`147 passed`**
  - `infra`: 1 文件 (`test/prisma.spec.ts`) / **`26 passed`**
- **L3 E2E**：端口探针 `3001/4001` 为 `NO_SERVICES_LISTENING`，遵守 `AGENTS.md` 禁止 AI 启服铁律，L3 标记 **`NOT_RUN`**（`bunx playwright test --list` 确认 `15-organization.spec.ts` `32` 条、全仓 `107` 条，且修改的 8 个 E2E 文件 `tsc --noEmit --skipLibCheck` 0 错误）。

---

## 4. Goal #3B Backlog 跟进状态与人类 E2E 复跑清单

- **已闭环 / 验证覆盖项**：
  - 个人注销孤儿组织泄漏（审查期间暴露的 `deleteOrphanedOrganizations` 死代码）已在本轮修复并补齐单测与集成回归；
  - `P-1` / 双锁并发与 `W30 MIG-D/E/F` 行为均已纳入 `organization-matrix.spec.ts` 409 用例（含 `5c` 与第 `10` 节跨组织锁隔离）。
- **仍留待后续小 PR / R2 优化的存量 Backlog（均不阻断 R1 Exit）**：
  - `N4`（`DataRequestViewDto` 补 `isRequester` 字段）、`N6–N10`（前端 capabilities 重拉错误提示、`CLEAR FAILED/PROCESSING` 门控与骨架态顺序）、`P1`（存量写入口展示链接门控）、`P7`（待随基线工程 PR 从 `eslint.config.mjs:41` `LEGACY_USE_EFFECT_FILES` 清理 `preferences-form.tsx`）。
- **人类启服后必跑 E2E 清单**：
  ```bash
  ./e2e/scripts/run-e2e-tests.sh --headless
  # 若仅单独回归 ToB R1 组织工作台 32 条 GWT：
  # bun run test:e2e -- e2e/modules/15-organization.spec.ts
  rm -rf e2e/test-results
  ```
  重点复跑验证：`15-organization.spec.ts` 全量 32 条 + Goal #3B 修复的 8 条（`T-OBW-002`、`T-CORR-005`、`W6-09`、`T-RPT-001`、`T-DATA-002/006/007`、`T-AI-003`）。

---

## 5. ToB R1 发布门 & Goal #4（P7–P8 组织只读/草稿 Agent）启动准入签字项

- [x] P0–P6 全部 L1/L1+/L2（`check:structure`、`check:org-scope` 62/0、`lint` 0 err、`typecheck` 4/4、`unit` 740、`web` 432、`money` 64、`dev-log` 31、`scripts` 24、`api` 849、`integration` 147、`infra` 26、`build`）全部实跑通过
- [x] `MIG-D`（删 `BusinessOrgScopeGuard`）+ `MIG-E`（`NOT NULL` / `ON DELETE RESTRICT`）+ `MIG-F`（删 8 表旧 `user_id`）本地切换零差异 & `benchmark-p6` 8/8 `0 Seq Scan`
- [x] 独立分支级别对抗审 `D6` R1（拦截 1 项口径夸大 `[Important]`）→ 修订闭合后经增量 R2 复核确认 `Important count: 0`
- [ ] **人类待签字项**：启动前后端服务跑通 `./e2e/scripts/run-e2e-tests.sh --headless`（确认 `15-organization.spec.ts` 32/32 与全量 107 条 E2E 0 failed）并将 Draft PR 审阅合入 `dev` 后，正式进入 **Goal #4（ToB R2：`AGENT-02..04` / `GWT-19..25`）**。
