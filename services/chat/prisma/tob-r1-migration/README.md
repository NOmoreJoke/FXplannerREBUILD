# MIG-B 默认组织回填与一致性核对 CLI（Goal #3A W15 · 技术方案 §12.2/§12.3）

对存量个人 MVP 数据做「每用户默认组织 + OWNER Membership + 业务行
organizationId/createdById 回填」的幂等运维 CLI。回填逻辑纯函数与集成测试见
`src/organization/organization-backfill.ts`（回填）与
`src/organization/organization-reconcile.ts`（§12.3 核对）。

## 做什么

- `backfill`（默认 dry-run）：只读估算将新建的组织数、组织设置数、各表待回填行数、
  待补建的已读行与待映射的数据请求，JSON 输出到 **stdout**（人类重定向落盘），
  零写入。估算条件与真实写入条件逐项一致（集成测试断言两者相等）。
- `backfill --apply --confirm-backup-target`：**双裸旗标缺一不可**，按 §12.2 七条
  规则回填（组织/Membership 幂等复用、设置复制、十类业务行
  `organizationId IS NULL` 条件回填、`PlanChangeLog` 按父校对、已读提醒拆
  `ReminderRead`、`DataRequest` scope 语义映射）。孤儿派生行预检失败直接阻断
  （退出 1，不静默归组）。
- `snapshot`：**§12.3 七类口径快照**（Goal #3C W29）——按用户 / 默认组织采集
  ① 每币种 `Account.balance` 合计；② 每计划 `targetAmount` /
  `PlanAllocation.{amount,usedAmount}` / `status` / `PlanInstallment` 数量与金额合计；
  ③ `Transaction` / `UsageRecord` / `Correction` 计数、`version` 合计与金额合计；
  ④ `CostLot` `remainingQty` / `unitCost` / `totalCost` 与 `UsageLotAllocation`
  数量 / 成本合计；⑤ 报告口径输入与 FIFO 汇总（已消耗成本、剩余批次成本、
  未知费用标记数）；⑥ 组织设置与个人设置（`baseCurrency` / `prepPreference` /
  `reminderEnabled` / `ledgerStartedAt`）；⑦ 100% 派生行
  `child.organizationId === parent.organizationId` 与 0 孤儿行。
  JSON 输出到 **stdout**（人类重定向落盘到仓库之外）。
- `drill`：**迁移前后快照比对演练**——采集前快照 → （可选）回填 → 采集后快照 →
  `compareMigrationSnapshots` 逐项比对 + `verify` 核对，**0 差异退出 0**，否则退出 1。
  不带 `--apply` 时为只读演练（回填走 dry-run，零写入）。
- `verify`：§12.3 一致性核对，集合式 SQL（6 条静态语句、26 项检查）：
  ① 每用户默认组织映射完整；② 十张业务表的**行集恒等**（任意行的 organization_id
  = 该行用户的默认组织）；③ 父子组织一致、孤儿行、FIFO 消耗守恒、批次守恒；
  ④ DataRequest 语义映射；⑤ ReminderRead 对账；⑥ 组织设置与个人设置同构。
  **0 diffs 退出 0**，否则输出差异清单退出 1。

### 执行模型与边界（评审 I-15/I-16 后）

- **分片事务**：`--apply` 按用户分片（默认 50 用户/片，每片一个事务、显式超时
  180s）。某片失败只回滚该片，已提交的分片保持有效；每一步都幂等，修复后重跑即
  续跑。全库单事务在生产数据量下会超出交互式事务超时，已弃用。
- **不改时间戳**：业务行与数据请求用原生 UPDATE 只写租户列（Prisma `updateMany`
  会经 `@updatedAt` 改写 `updated_at`，违反 §12.2.6）。演练证据：回填前后 17 张表
  「整行剔除租户列」的 MD5 指纹完全不变。
- **只映射存量数据请求**：仅 `organizationId IS NULL` 的行（EXPORT/DELETION→PERSONAL、
  历史 CLEAR→默认组织）。ToB R1 之后新建的组织级请求绝不被重跑改写。
- **默认组织 = 最早的 ACTIVE OWNER 成员关系**（与运行时
  `resolveDefaultOrganizationId` 同口径）。用户可同时是多个组织的 Owner。
- **verify 是迁移时点闸门**：须在停写窗口内对备份副本/生产库执行。上线后业务数据
  可在非默认组织演进、组织偏好可独立修改，全量 verify 不再是运行期不变量，不作
  常驻巡检。

## 不做什么（边界）

- **不自动连接任何特定库**：`DATABASE_URL` 由运行环境提供；写入模式拒绝生产目标
  ——库名含 `fxplanner_prod`（**大小写不敏感**）或 `NODE_ENV=production` 一律退出 1
  （§12.4「生产执行不由 AI 自动进行」；只读的 `verify` 不受此限）。
- **不删除、不禁用 userId 读路径**：兼容窗口由 Goal #3B 收口，本工具只做增量
  映射；MIG-E 收紧不在本工具范围。
- **不改金额/ID/版本/时间戳**（§12.2.6）；`DataRequest` 状态机字段一律不动
  （§12.2.7）。
- **不回滚**：A 为纯增量可回滚代码；B 的回滚不得删除已核验的新数据——需要
  回退时以备份副本重建（见 `docs/handoff/PRE-GOAL3A-CLOSURE-20261123.md` §6
  恢复流程），本工具不提供 down 命令。

## 为何独立成目录

与 `prisma/rate-cache-migration/` 同一先例：迁移 CLI 与 Prisma schema 同层
（服务内运维工具），复用服务的 PrismaClient 与 `src/organization/` 回填/核对
纯逻辑，保证回填口径与集成测试同源；不入 `scripts/` 是因为其运行上下文
（cwd、依赖闭包）绑定 `services/chat`。

## 运行（在 services/chat 下）

先在**备份副本/演练库**（本地为 `fxplanner_new_db_migbak`，恢复流程见
PRE-GOAL3A-CLOSURE 文档）应用 MIG-A 迁移
`20261123100000_tob_r1_mig_a_org_foundation`，然后：

```bash
DATABASE_URL="postgresql://…/fxplanner_new_db_migbak" \
  bun prisma/tob-r1-migration/backfill.ts backfill            # dry-run
DATABASE_URL="postgresql://…/fxplanner_new_db_migbak" \
  bun prisma/tob-r1-migration/backfill.ts backfill --apply --confirm-backup-target
DATABASE_URL="postgresql://…/fxplanner_new_db_migbak" \
  bun prisma/tob-r1-migration/backfill.ts verify              # 目标 0 diffs
DATABASE_URL="postgresql://…/fxplanner_new_db_migbak" \
  bun prisma/tob-r1-migration/backfill.ts snapshot            # 七类口径快照（stdout JSON）
DATABASE_URL="postgresql://…/fxplanner_new_db_migbak" \
  bun prisma/tob-r1-migration/backfill.ts drill               # 快照前后比对（只读）
DATABASE_URL="postgresql://…/fxplanner_new_db_migbak" \
  bun prisma/tob-r1-migration/backfill.ts drill --apply --confirm-backup-target
```

验收口径（GOAL-3A W15 Checkpoint）：dry-run → apply → verify 连续两次全绿、
0 diffs，且第二次 apply 的 organizationsCreated=0（幂等）。

W29（MIG-C）追加口径：`snapshot` 与 `drill` **只写 stdout**，不向仓库根目录 /
`logs/` / 任何产物目录写迁移日志或快照文件；需要落盘时由人类把 stdout 重定向到
仓库之外的路径（临时比对文件只放 `os.tmpdir()` 并清理）。

## MIG-F 前瞻（Goal #3C W30）

`MIG-F` 会删除业务共享表上的冗余 `user_id`、`user_settings` 的 legacy 设置列与
`reminders.read_at`。本目录的两个工具都**先探测库阶段**
（`src/organization/migration-schema-capabilities.ts`：查询
`information_schema.columns`，只读、无拼接）：

- **回填**（`organization-backfill.ts`）：MIG-F 之后，逐表跳过依赖 `user_id` 的
  回填分支（该表恒 0 行），个人设置复制与已读提醒回填同样跳过——不再因
  「列不存在」崩溃；
- **核对**（`organization-reconcile.ts`）：MIG-F 之后改走**组织维度基础校验**
  （默认组织映射、派生行父子同组织、孤儿行、FIFO 与批次守恒），SQL 中不引用任何
  已删除列，因此 MIG-F 之后依然可以运行基础一致性校验。
