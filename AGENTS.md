# AI 开发指南

**规则唯一权威来源**。任何操作前必读。

## 技术栈

Bun + Turbo + Next.js + NestJS + Prisma + Playwright + Vitest

## 目录结构（严格执行）

**铁律**：

1. 任何文件必须落在下述目录树定义的位置
2. 目录树未列出的路径禁止创建（包括子目录）
3. 不确定归属时必须先问人类，禁止猜测或自创目录
4. 新增/删除 package、目录，或文件归属位置变化时，必须同步更新本文件的目录树及「文件归属规则」表
5. 违反此规则的代码直接打回

```
├─ clients/chat-web/                # Next.js 前端
│  ├─ app/                          # App Router 路由
│  │  ├─ page.tsx                   #   / 公开落地页
│  │  ├─ login/  register/          #   认证页
│  │  └─ (protected)/               #   保护区（守卫在组内 layout.tsx）
│  │     ├─ plans/                  #     换汇计划（new/ 创建、page 列表、[id]/ 详情）
│  │     ├─ corrections/            #     更正与日志（new/ 更正页，targetType/targetId 由查询参数进入）
│  │     └─ projects/               #     示例业务页
│  ├─ components/
│  │  ├─ ui/                        # shadcn 原语
│  │  ├─ base/                      # 项目级基础组件
│  │  └─ business/<domain>/         # 业务组件（按领域分目录）
│  ├─ hooks/                        # 自定义 hooks
│  ├─ lib/
│  │  ├─ api/                       # 后端 API 客户端
│  │  ├─ dev-log/                   # 本地开发错误采集（@sentry/browser → dev-log-server）
│  │  ├─ stores/                    # zustand 状态
│  │  └─ utils.ts                   # 工具函数
│  ├─ instrumentation-client.ts     # 客户端错误采集初始化（仅 dev 生效）
│  ├─ proxy.ts                    # 边缘路由守卫
│  └─ public/                       # 静态资源
│
├─ services/chat/                   # NestJS 后端
│  │                                # ⛔ 此目录下仅允许：src/ prisma/ test/ + 配置文件
│  │                                # ⛔ 禁止出现：changes/ clients/ logs/ test-results/ 等
│  ├─ src/
│  │  ├─ main.ts                    # 入口（/api 前缀、CORS、env 校验）
│  │  ├─ app.module.ts              # 根模块（模块唯一注册点）
│  │  ├─ app.controller.ts          # health / hello 探针
│  │  ├─ auth/                      # L1：JWT 认证
│  │  ├─ project/                   # L2：示例业务模块（禁止在此定义前端已有的类型）
│  │  ├─ config/                    # env 加载与 zod 校验（12-Factor）
│  │  ├─ database/                  # 数据库辅助
│  │  └─ prisma/                    # PrismaService
│  ├─ prisma/                       # schema + migrations + seed
│  └─ test/
│     ├─ api/                       # 接口测试
│     ├─ integration/               # 集成测试
│     ├─ helpers/                   # 共享测试工具
│     └─ prisma.spec.ts             # 基础设施测试
│
├─ packages/                        # ⛔ 每个 package 必须含 README.md：做什么（职责）/ 不做什么（边界）/ 为何独立成包
├─ packages/money/                  # 跨端共享精度计算纯函数库（币种常量、金额/汇率舍入规则；零 IO）
├─ packages/dev-log-server/         # 本地开发前端错误日志接收服务（仅 dev；logs/ 为运行产物，gitignored）
├─ packages/eslint-config/          # 共享 ESLint 配置
├─ packages/typescript-config/      # 共享 tsconfig
│
├─ e2e/                             # Playwright E2E（跨前后端，独立一层）
│  ├─ modules/                      # 测试用例
│  ├─ fixtures/  helpers/           # 夹具与辅助
│  ├─ scripts/                      # E2E 运行脚本
│  └─ test-results/                 # 全部运行产物（gitignored）⛔ 仅此处允许
│     └─ playwright-report/         # HTML 报告
│
├─ infra/compose/                   # Docker Compose + Dockerfile
├─ scripts/                         # 工程脚本（init / test / worktree）+ __tests__/
├─ changes/                         # ⛔ 变更文档唯一位置（需求/方案/验收），按功能名称分目录
│  ├─ tob-agent-workspace/          # ToB 组织工作台与 Agent 需求和技术方案
│  └─ realtime-rate/                # MVP-F0 汇率回补与缓存迁移实施底稿（Goal #1 任务 B/C 执行口径）
├─ docs/                            # 长期规范文档
│  ├─ VERIFY.md                     # 验证驱动、属性/差分测试与 Diff 触发防回归规范
│  ├─ ITERATION-REFACTOR-ROADMAP-20261119.md # 迭代与重构总方案（MVP-F0/F1/F2 → ToB R1/R2）
│  ├─ VIBE-CODING-PLAYBOOK.md       # 基于本仓工具链的 Vibe Coding 最佳实践手册
│  └─ handoff/                      # 跨会话交接（OVERNIGHT-* / GOAL-* / 状态快照）
├─ .changeset/                      # Changesets 配置与变更记录
├─ .husky/                          # git hooks
└─ .pi/skills/                      # AI 工作流技能存档（verify/ 为本地可选）
```

## 核心约定

- **AI 禁止启动服务**（dev/compose up）
- 其他约定见目录树注释

### 文件归属规则

| 要加什么         | 放哪里                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| 新页面（公开）   | `app/<路由>/`                                                             |
| 新页面（需登录） | `app/(protected)/<路由>/`，不写任何校验代码                               |
| 新业务组件       | `components/business/<领域>/`，带 index.ts 桶文件                         |
| 跨领域复用组件   | `components/base/`（2 处以上复用才准进）                                  |
| shadcn 原语      | `bunx shadcn add`，进 `components/ui/`，不手改                          |
| 新后端模块       | `services/chat/src/<模块>/`，在 `app.module.ts` 注册一次                |
| 新 package       | `packages/<名称>/`，必须含 `README.md`：做什么（职责）、不做什么（边界/非目标）、为何独立成包 |
| 新共享类型       | 后端 DTO 为唯一来源，前端 `bun run generate:api` 从 OpenAPI 生成（禁止手写共享类型） |
| 跨端共享计算逻辑 | `packages/money/`（仅限纯函数：精度、舍入、币种常量；有 IO 的逻辑禁止进包） |
| 接口测试         | `services/chat/test/api/<模块名>.spec.ts`（一个 controller 一个文件）     |
| 集成测试         | `services/chat/test/integration/<模块组合>.spec.ts`（一个业务流一个文件） |
| 单元测试         | 与源码同目录`<被测文件>.spec.ts`                                          |
| E2E 用例         | `e2e/modules/<编号>-<模块>.spec.ts`                                       |
| ToB 组织工作台与 Agent 规划 | `changes/tob-agent-workspace/` |
| MVP-F0 汇率回补与缓存迁移底稿 | `changes/realtime-rate/` |
| 验证与防回归规范 | `docs/VERIFY.md`（验证分级、属性/差分测试、Diff 触发检查） |
| 迭代路线与工作流手册 | `docs/ITERATION-REFACTOR-ROADMAP-20261119.md`、`docs/VIBE-CODING-PLAYBOOK.md` |
| 跨会话交接文档   | `docs/handoff/`（夜间批次产出：OVERNIGHT-* / 接力目标提示词：GOAL-* / 状态快照；需求/方案/验收仍归 `changes/`） |

### 组件引用

单向依赖：`business → base → ui`，禁止反向。

### 测试约定

- **三类防愚弄测试（Anti-Gaming Tests）**：
  - **E2E + 行为断言量表**：前端只测 `lib/hooks`，组件与业务流防线是 Playwright E2E；对照 `docs/VERIFY.md` 与 `docs/handoff/` 行为断言清单打分，拒绝只测 mock 的同义反复（tautological）测试。
  - **属性测试（Property-based Testing，`fast-check`）**：`packages/money/`（币种常量、金额/汇率换算、舍入规则纯函数）及核心 DTO 校验逻辑新增或修改时，**必须编写属性测试**，验证往返守恒（Round-trip）、精度/非负/守恒不变量（Invariants）、重复计算幂等性（Idempotency）与等价性（Equivalence）。
  - **差分测试（Differential Testing）**：从旧版 `FXplanner` 迁移换汇计算、计划生成或更正流水逻辑时，以旧版输出或黄金样本集为 Oracle 同输入比对，归一化无关噪音并记录合法差异白名单。
- **廉价检查先行 & 本地 3 轮自愈熔断**：先跑本地 `bun run typecheck` / `bun run lint` / `bun run test unit api integration infra web scripts`，通过后再跑 E2E；同一测试/构建失败本地自动修复最多 **3 轮**，连续 3 轮未果必须立即停机汇报人类，严禁死循环盲改。
- **Flaky 测试零容忍**：严禁为刷绿删减业务断言、添加硬编码 `sleep`、随意放大 timeout 或加 `skip`；偶发失败若 3 轮内找不到根因，必须显式移除/隔离并在验收报告中写明原因。
- 测试工具进 `test/helpers/`，禁止 spec 间复制
- 测试产物只进 `e2e/test-results`，⛔ 根目录、`services/`、`clients/` 下禁止出现 `test-results/` `playwright-report/` `logs/`（跑完 E2E 查看报告后、提交前及时清理 `e2e/test-results`，避免干扰安全门禁扫描）

### 质量红线

方案必含测试设计，实施必跑通测试（0 failed），验收必附测试日志，且改动须过 `docs/VERIFY.md` 命中的 Diff 触发项。

**独立审查隔离与三态标签**：
- 审查规则与门禁配置一律从 `main` / 基线分支读取，被审改动不得自改裁判标准；跨轮复核仅基于前序记录与增量 diff。
- 审查意见强制标注 **`[Important]`（必改阻断）/ `[Nit]`（非阻断建议）/ `[Pre-existing]`（存量问题，记入 backlog 不阻断本轮）**。

**打回重做**：方案无测试章节、测试未执行、验收无证据、核心精度改动缺属性测试、或为刷绿擅删断言 / 加 `sleep` / `skip`。

### 提交规范

Conventional Commits（commitlint 强制）。用 `bun run commit` + `bun run changeset`。
- **Commit 验证戳记**：提交说明尾部须附验证戳记 `Verified: <unit|property|api|e2e|diff|none (reason)>`。
- **门禁三态演进（`off → observe → enforce`）**：安全/质量 Hook 新规则先开 `observe` 统计误报；在 `enforce` 模式下若遇结构性规则冲突（如 `docs/handoff/MIMOSA-GATE-20261105.md` 记录的测试 helper SSRF 误报）或单会话连续被拦 2 次，允许在提交说明或 `docs/handoff/` 中写明豁免原因与验证证据后放行，严禁无记录静默旁路。

### 路径引用格式

✅ `services/chat/src/correction/correction.service.ts:1082`

❌ `[correction.service.ts](path)` 或 `./path`
