---
"@fxplanner-new/chat": minor
"@fxplanner-new/chat-web": minor
---

ToB R1 Part C（MIG-C..F 切换收口、跨租户全矩阵与 R1 退场验收 · W29–W32）：

- **确定性租户隔离与 MIG-C 零差异核对（W29）**：新增 `scripts/check-org-scope.ts`（`ts-morph` AST 扫描 12 业务模块防无组织裸查与旁路）及正/负向反证单测；补齐 `migration-schema-capabilities.ts`、`organization-migration-snapshot.ts` 与核对/回填逻辑。
- **MIG-D/E/F 不可逆切换与 P6 性能验证（W30）**：下线 `BusinessOrgScopeGuard` 与兼容期单组织回退（缺 `X-Organization-Id` 一律 400 `ORGANIZATION_REQUIRED`），登录落地解析改走个人域 `GET /organizations`；落库 `20261126190000_tob_r1_mig_e_tighten_constraints`（10 表 `organization_id SET NOT NULL`、9 共享账本表 `ON DELETE RESTRICT`、删旧用户部分唯一索引）与 `20261126191000_tob_r1_mig_f_drop_legacy_columns`（删 8 表旧 `user_id`、`UserSettings` 账本旧列、`reminders.read_at`，重命名 `data_requests.requester_user_id` 为可空 `ON DELETE SET NULL`）；修复个人注销时 `deleteOrphanedOrganizations` 漏删空组织问题；新增 `benchmark-p6.ts` 实证 8/8 核心查询均命中 `organization_id` 打头索引（`0 Seq Scan`，P50 `0.0775–0.0972ms`）。
- **409 跨租户 API 全矩阵与 32 用例 R1 验收 E2E（W31）**：新增 `organization-matrix.spec.ts` 覆盖 16 域 55 条组织/业务端点（含 37 条单组织缺头 400、十接口列表读隔离与组织锁跨组织隔离）；将 `e2e/modules/15-organization.spec.ts` 扩充至 32 条完整覆盖 `GWT-1..18` 与 `GWT-26..30`。
- **R1 验收落盘与 R2 准入门（W32）**：新增 `changes/tob-agent-workspace/验收记录.md` 逐项对账 R1 追踪表，同步更新 `README.md`、`docs/FEATURE-MAP.md`、`AGENTS.md` 与 `docs/handoff/OVERNIGHT-TOB-R1-C-20261126.md`。
