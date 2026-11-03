# OVERNIGHT-MINIMAX-REVIEW-20261103（对抗审记录 + 整改闭环）

> **执行者披露**：Goal 指定「ZCode 调度 MiniMax Code」做对抗审。经探测，本机 MiniMax Code 为
> GUI-only Electron 应用（`/Applications/MiniMax Code.app`，无 headless CLI；`minimax`/`minimax-code`
> 不在 PATH，插件亦无调度接口）。**实际审阅由 codex CLI（gpt-6.1-sol，high reasoning）替代执行**，
> checklist 与 Goal 中 MiniMax 条款逐字同源（钱/FX 正确性、UI 无死胡同、E2E 真实性、秘密泄漏、
> 范围蔓延、CI 成本）。Kaiming 如需原厂 MiniMax 复核，可在 GUI 中打开 PR #1 diff 手动执行。
>
> 审阅对象：PR #1（`feat/iteration-a-mvp-closeout` → `dev`），代码 diff ~4000 行
> （排除 bulk 导入文档与 bun.lock）。审阅全程只读。

## 第一轮结论（2026-11-04 凌晨）

**总判定：不能过 blocker 关（2 BLOCKER / 3 MAJOR / 3 MINOR）**

| 级别 | 编号 | 内容 | 判定 | 处置 |
| --- | --- | --- | --- | --- |
| BLOCKER | B1 | usage 日期截断 UTC+8 日 0 点 vs 买入原样时刻：FIFO 精确时刻排序下同日使用排到买入前，更正账本重放误报资金不足、阻断合法更正；展示层显示前一天 | **成立（已修）** | `parseUsedAt` 原样保留时刻；`assertUsedAtInRange`/`assertTransactedAtInRange` 下界改 UTC+8 日历日粒度（保留「起点当日可补录」修复意图）；新增 `correction-replay.spec.ts #6` 回归用例 |
| BLOCKER | B2 | 新增 `docs/handoff/` 未同步 AGENTS.md 目录树（目录门禁铁律） | **成立（已修）** | AGENTS.md 目录树补 `docs/handoff/` |
| MAJOR | M1 | 计划写操作后账户系查询缓存不失效（≤5min 旧数据） | 成立（已修） | 详情页 onApplied 与创建成功失效 `["accounts"]` + 首页状态；usage 路径原已覆盖 |
| MAJOR | M2 | allocations `take:100` 截断与汇总全量口径错位（理论场景「明细空、汇总非零」） | 成立（已修） | 去掉截断，代码注释记录原因 |
| MAJOR | M3 | 直接 `bun run test:e2e` 自定义端口回归（CORS_ORIGIN 不再注入） | 成立（已修） | playwright.config 补根 `.env.local` 回退 |
| MINOR | m1 | LC-004 余额断言 `.first()` 混配「余额」卡 | 成立（已修） | 锚定 `[data-slot="card"]` 未分配余额卡 + 新增「已分配=0」对账 |
| MINOR | m2 | 安全审计文档「运行时闭包干净」结论过度（qs 为运行时传递依赖） | 成立（已修） | 两处措辞收敛 |
| MINOR | m3 | 存量 plan-detail-card 用 Number 算百分比 | 认同不改 | 非本 PR 引入，M7 已交付口径；列为后续统一 Decimal 的技术债 |

审阅者对 checklist 六项另给：钱/FX 新增逻辑 PASS、UI 无死胡同 CONCERN（随 M1 闭环）、
E2E 真实性 CONCERN（随 m1 闭环）、秘密泄漏 PASS、CI 成本 PASS（reflect-metadata 根依赖合理）。

## 第二轮（blocker 复看，修复 commit b4e3af5）

- 复看范围：修复 commit `b4e3af5`（14 files, +146/−24）+ B1 测试证据（后端全量 766/766、E2E 7/7 首过）。
- **B1：PASS**——`parseUsedAt` 不截断经集成测试 #6 断言原样存储；同刻排序由 LEDGER_TYPE_ORDER
  （PURCHASE=1 < USAGE=2）保障；日粒度下界不构成绕过（重放语义为「preview 记录违规、apply 阻断」，
  真实历史缺口仍被正确拦截）；边界（起点 null、未 apply、历史缺口 409）由既有 #8 与 calculator
  单测补足。复审指出：存量已截断数据不自动修复（本地/E2E 造数，可接受）。
- **B2：FAIL（残留）**——目录树已补，但 AGENTS.md 铁律 4 要求**目录树与「文件归属规则」表同时同步**，
  归属表仍缺交接文档行。另给两项非阻断：审计文档两处措辞仍与 qs 例外矛盾；LC-004 已分配断言
  建议加 `exact: true`（"0.0000" 可子串匹配 "6000.0000"）。

## 第三轮（B2 收口）

- 补「文件归属规则」表：`跨会话交接文档 → docs/handoff/（需求/方案/验收仍归 changes/）`；
- 审计文档摘要行与结论行同步收敛（critical/high 隔离 + qs 例外表述一致）；
- LC-004 已分配断言加 `exact: true`。

## 最终判定

**PASS——B1 与 B2（含归属表同步）全部解除，draft PR #1 可交 Kaiming 人类终审。**

依据：第二轮复审独立确认 B1 修复成立且无绕过；B2 残留项（归属表一行）为机械补齐，
第三轮逐项落地（见 commit 记录），无行为代码变更（仅 AGENTS.md / 审计文档 / E2E 断言收紧），
后端全量与 E2E 证据在第二轮已确认、第三轮改动不触及运行时路径。

## 遗留给 Kaiming

1. m3（plan-detail-card Number→Decimal）与「usage 展示层按 UTC+8 日显示」（列表已按日期展示，
   如需时区标注属体验债）列为后续小票。
2. 既有测试数据中历史截断日期（本地/E2E 造数）不影响新逻辑，无迁移需求；生产无存量数据。
3. Mimosa Git 门禁对本仓的处置决策（见 OVERNIGHT-ZCODE-20261103.md §Mimosa 披露）。
