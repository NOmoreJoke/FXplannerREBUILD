# MIG-B 默认组织回填与一致性核对 CLI（Goal #3A W15 · 技术方案 §12.2/§12.3）

对存量个人 MVP 数据做「每用户默认组织 + OWNER Membership + 业务行
organizationId/createdById 回填」的幂等运维 CLI。回填逻辑纯函数与集成测试见
`src/organization/organization-backfill.ts`（回填）与
`src/organization/organization-reconcile.ts`（§12.3 核对）。

## 做什么

- `backfill`（默认 dry-run）：只读估算将新建的组织数与各表待回填行数，JSON
  输出到 **stdout**（人类重定向落盘），零写入。
- `backfill --apply --confirm-backup-target`：**双裸旗标缺一不可**，在单事务内
  按 §12.2 七条规则回填（组织/Membership 幂等复用、设置复制、九类业务行
  `organizationId IS NULL` 条件回填、`PlanChangeLog` 按父校对、已读提醒拆
  `ReminderRead`、`DataRequest` scope 语义映射）。孤儿派生行预检失败直接阻断
  （退出 1，不静默归组）。
- `verify`：§12.3 全量一致性核对——userId 视角 vs organizationId 视角逐域聚合
  比对（账户余额/计划/分配/交易/使用/更正/批次/FIFO 守恒/设置同构）+ 父子
  organizationId 一致 + 孤儿派生行计数。**0 diffs 退出 0**，否则输出差异清单
  退出 1。

## 不做什么（边界）

- **不自动连接任何特定库**：`DATABASE_URL` 由运行环境提供；生产
  `fxplanner_prod` 直接拒绝执行（§12.4「生产执行不由 AI 自动进行」）。
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
```

验收口径（GOAL-3A W15 Checkpoint）：dry-run → apply → verify 连续两次全绿、
0 diffs，且第二次 apply 的 organizationsCreated=0（幂等）。
