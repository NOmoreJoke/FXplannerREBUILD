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
├─ docs/                            # 长期规范文档
├─ .changeset/                      # Changesets 配置与变更记录
├─ .husky/                          # git hooks
└─ .pi/skills/                      # AI 工作流技能存档
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

### 组件引用

单向依赖：`business → base → ui`，禁止反向。

### 测试约定

- 前端只测 `lib/hooks`，组件测试靠 E2E
- 测试工具进 `test/helpers/`，禁止 spec 间复制
- 测试产物只进 `e2e/test-results`，⛔ 根目录、`services/`、`clients/` 下禁止出现 `test-results/` `playwright-report/` `logs/`

### 质量红线

方案必含测试设计，实施必跑通测试（0 failed），验收必附测试日志。

**打回重做**：方案无测试章节、测试未执行、验收无证据。

### 提交规范

Conventional Commits（commitlint 强制）。用 `bun run commit` + `bun run changeset`。

### 路径引用格式

✅ `services/chat/src/project/project.service.ts:42`  
❌ `[project.service.ts](path)` 或 `./path`
