# 旧汇率缓存迁移工具（MVP-F0-1 B2 · 实施底稿 §3）

对 `exchange_rates` 中历史 er-api / frankfurter 旧方向行做只读盘点 → 冻结 →
原位转换 → 回滚验证的运维 CLI。纯函数（候选分类/期望值派生/冻结校验/执行
引擎）与测试见 `src/rate/rate-migration-plan.ts` + `rate-migration-plan.spec.ts`。

## 做什么

- `inventory`：只读盘点全表，按底稿 §3.1 分类（ErApi/Frankfurter 候选、
  ABC/identity 排除、sellRate 非空与非法/归零/越界冲突行单列），
  为清单生成唯一的 `inventoryId`，将 JSON 输出到 **stdout**（人类重定向落盘）。
- `invert`：经 `verifyFrozenPlan` 全量校验（candidates/conflicts/excludedCount/
  checksum 四侧比对重算结果，stdin 中的候选永不直接执行）后，按【重算计划】
  对候选行做「**全冻结字段条件更新**」（id/rate 之外，base/quote/source/
  sellRate/observedAt/createdAt 原值一并进 where——任一字段漂移即 0 命中），
  期望值 = invertQuoteRate 口径（HALF_UP 10 位）；批序先 er-api 后
  frankfurter（§3.3），**全部候选在同一计划事务内执行**（任一批失败回滚
  整个计划，无半写）；缺 `--apply` 为 dry-run。
- `rollback`：凭数据库内的完成记录及行归属，按原圈选范围逐字段核对并恢复原汇率。

## 不做什么（边界）

- **不自动连接任何特定库**：`DATABASE_URL` 由运行环境提供，工具无法验证
  「备份性」——`--apply` 必须显式携带 `--confirm-backup-target`（人工确认
  指向备份副本）；生产 `fxplanner_prod` 的停写窗口与执行由人类另行批准
  （底稿 §3 步骤 2「停旧写并做可恢复备份」是人类操作前置，本工具不覆盖）。
- **不做文件系统操作**：清单经 stdout/stdin 管道传递（人类落盘），消除
  路径穿越面。
- **不回补、不重拉**：ErApi 免费档无历史端点，冷缺口按底稿 §2 由图表参考
  序列另行披露；本工具只做方向原位转换。
- **冲突行拒绝放行**：清单含任何冲突行（sellRate 非空 / 非法 / 归零 /
  越界）时 `--apply` 直接拒绝（底稿 §3.1「原值仍不可判定时停止该批」），
  人工核实并重新盘点冻结后才可执行。

## 为何独立成目录

迁移 CLI 与 Prisma schema 同层（服务内运维工具），复用服务的
PrismaClient 与 `src/rate/rate-invert` 取倒数口径，保证转换期望值与新
写入口径永远同源；不入 `scripts/` 是因为其运行上下文（cwd、依赖闭包）
绑定 `services/chat`。

## 运行（在 services/chat 下）

先在备份副本应用 Prisma 迁移 `20261120090000_rate_cache_migration_receipt`。
盘点后，人工核对并填入 `approvedCandidateIds`，保留这份清单及其 `inventoryId`
供转换、复跑与回滚使用。

`invert` 和 `rollback` 写入前需要同时传入两个独立的裸旗标。旗标带值
（无论用空格还是等号）、拼写错误或重复时，CLI 在读取清单前以退出码 1 结束。

```bash
bun run prisma/rate-cache-migration/migrate.ts inventory > /path/to/inventory.json
bun run prisma/rate-cache-migration/migrate.ts invert < /path/to/inventory.json          # dry-run
bun run prisma/rate-cache-migration/migrate.ts invert --apply --confirm-backup-target < /path/to/inventory.json
bun run prisma/rate-cache-migration/migrate.ts rollback --apply --confirm-backup-target < /path/to/inventory.json
```

## 幂等、复跑与防漂移

- `invert --apply` 和 `rollback --apply` 的全计划事务期限为 30 秒，
  从事务开始计时，两批共用这个预算。超过期限会回滚整个计划，可从同一份冻结清单复跑。
- 本地 PostgreSQL 双源演练使用两组 Frankfurter 365 天窗口工作日点和一组
  ErApi 30 天日快照（552 条圈选候选）。在每条实际更新受控增加 10 ms 的情况下，
  旧版 5 秒期限两次触发超时。新期限下验收检查全量转换、复跑、回退及
  最后一条 Frankfurter 记录漂移后的全表一致性。生产备份副本的候选量与耗时待实测。
- 首次 `invert --apply` 锁定 `inventoryId` 对应的圈选集合、全冻结字段和目标值。
  数据库完成记录与实际改写行上的归属标记同事务提交。数值不变的候选只核对，
  也纳入圈选校验和。
- 候选范围按底稿 §3.1 冻结：ErApi 仅 quote=TWD 的非恒等行（其余 ErApi 行
  一律冲突单列不放行）；Frankfurter 按实际曾写币对；ABC/identity 排除；
  方向证据以冻结 ID 白名单（清单 JSON）承载，人工核对后方可执行；
- 复跑同一份已提交清单时，只核对目标值、其余冻结字段和归属，更新数为 0。
  盘点和读回均用无参数的 `Prisma.Decimal#toFixed()` 保留精确十进制文本，核对时忽略尾零。
  只凭目标值相同的行无法取得完成记录或归属。
- 回滚要求已提交的完成记录、完全相同的圈选范围和当前行归属。普通更新会清除
  原归属，即使它写回相同字段值。任一候选失去归属或字段漂移会中止整个事务。
- 回滚完成后保留完成记录，重复回滚只核对恢复状态，更新数为 0。如需再次转换，
  重新盘点并取得新清单。并发事务冲突时，使用原清单复跑核对已提交状态。
- 旧清单可用于 dry-run。旧版 CLI 转换的行没有完成记录，须通过原备份恢复。
  新版写入需使用新版 `inventory` 生成的清单。

## 旧版演练记录（2026-11-19/20 夜间，本地测试库真实 CUID 行）

- 种子 2 行（er-api CNY/TWD 4.7567 + er-api 带 sellRate 冲突行）；
- inventory：候选 1 / 冲突 1（sell-rate-non-null，CUID id 列出）；
- `invert --apply`（含冲突）→ **拒绝执行**（EXIT 1，逐条列出 id/原因）；
- 移除冲突行重新盘点后 `invert --apply --confirm-backup-target`：
  条件命中转换 1（4.7567 → 0.2102297812，FX-01 夹具值；缺
  --confirm-backup-target 或 approvedCandidateIds 为空时均拒绝）；
- 二遍 `invert --apply`：转换 0、幂等复跑已达成 1（全冻结字段核对 +
  数值归一化域判定）；
- `rollback --apply`：条件命中 1（恢复 4.7567），逐字段零差异；
- 单元层另覆盖冻结字段漂移中止（observedAt 漂移 → 抛错）、No-op 行
  核对（不产生 UPDATE）、「rate 已是目标值但其他字段漂移 → 抛错」
  与逐字段条件断言（spec：executeMigrationBatches 可执行差分 8 用例）。
- 演练后已清理种子行。**生产演练仍须在人类提供的备份副本执行**（本机
  实例无完整生产形态数据，底稿 §3.1 盘点表中的生产库待办不变）。
