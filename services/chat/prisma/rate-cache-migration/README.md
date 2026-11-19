# 旧汇率缓存迁移工具（MVP-F0-1 B2 · 实施底稿 §3）

对 `exchange_rates` 中历史 er-api / frankfurter 旧方向行做只读盘点 → 冻结 →
原位转换 → 回滚验证的运维 CLI。纯函数（候选分类/期望值派生/冻结校验/执行
引擎）与测试见 `src/rate/rate-migration-plan.ts` + `rate-migration-plan.spec.ts`。

## 做什么

- `inventory`：只读盘点全表，按底稿 §3.1 分类（ErApi/Frankfurter 候选、
  ABC/identity 排除、sellRate 非空与非法/归零/越界冲突行单列），
  输出冻结清单 JSON 到 **stdout**（人类重定向落盘）。
- `invert`：经 `verifyFrozenPlan` 全量校验（candidates/conflicts/excludedCount/
  checksum 四侧比对重算结果，stdin 中的候选永不直接执行）后，按【重算计划】
  对候选行做「**全冻结字段条件更新**」（id/rate 之外，base/quote/source/
  sellRate/observedAt/createdAt 原值一并进 where——任一字段漂移即 0 命中），
  期望值 = invertQuoteRate 口径（HALF_UP 10 位）；批序先 er-api 后
  frankfurter（§3.3），**全部候选在同一计划事务内执行**（任一批失败回滚
  整个计划，无半写）；缺 `--apply` 为 dry-run。
- `rollback`：按同一清单反向条件更新 → 原值。

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

```bash
bun run prisma/rate-cache-migration/migrate.ts inventory > /path/to/inventory.json
bun run prisma/rate-cache-migration/migrate.ts invert < /path/to/inventory.json          # dry-run
bun run prisma/rate-cache-migration/migrate.ts invert --apply --confirm-backup-target < /path/to/inventory.json
bun run prisma/rate-cache-migration/migrate.ts rollback --apply --confirm-backup-target < /path/to/inventory.json
```

## 幂等、复跑与防漂移

- 条件更新 = 全冻结字段匹配：第二遍 `invert --apply` 行已为目标值 →
  更新数 0、「幂等复跑已达成」计数（底稿 §3.4「已完成批次更新数为 0」）；
  幂等判定在数值归一化域进行（Prisma Decimal.toString() 去尾零：
  目标 5.0000000000 落库读回 "5"，直比会误判漂移）；
- 候选范围按底稿 §3.1 冻结：ErApi 仅 quote=TWD 的非恒等行（其余 ErApi 行
  一律冲突单列不放行）；Frankfurter 按实际曾写币对；ABC/identity 排除；
  方向证据以冻结 ID 白名单（清单 JSON）承载，人工核对后方可执行；
- 冻结后任一字段漂移（含并发 upsert 改写 source/createdAt）→ 全字段条件
  0 命中且非幂等状态 → 抛错回滚【整个计划事务】（含已执行的前批，无半写）；
- 冻结清单 JSON 即完成台账（无 schema 版本标记）；`verifyFrozenPlan`
  全量比对不一致时拒绝执行（防清单或数据漂移）。

## 演练记录（2026-11-19/20 夜间，本地测试库真实 CUID 行）

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
