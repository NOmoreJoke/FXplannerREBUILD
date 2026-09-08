# AI 开发指南（通用模板版）

> 全栈 Monorepo 项目模板 - AI 协作规范（规则的唯一权威来源）

## 🛠 技术栈

- **包管理**: Bun
- **构建工具**: Turbo (Monorepo)
- **前端**: Next.js + React
- **后端**: NestJS + Prisma
- **测试**: Playwright (E2E) + Vitest (单元/接口/集成) + bun:test (scripts)

## 📂 目录结构（权威定义）

> ⚠️ **强制约定**：任何文件的增、删、改都必须严格落在下表定义的位置。
> 新增文件前先查「文件归属规则」确定位置；没有合适位置时先与人确认，**禁止随意新建目录**。

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
│  │  ├─ stores/                    # zustand 状态
│  │  └─ utils.ts                   # 工具函数
│  ├─ proxy.ts                    # 边缘路由守卫
│  └─ public/                       # 静态资源
│
├─ services/chat/                   # NestJS 后端
│  ├─ src/
│  │  ├─ main.ts                    # 入口（/api 前缀、CORS、env 校验）
│  │  ├─ app.module.ts              # 根模块（模块唯一注册点）
│  │  ├─ app.controller.ts          # health / hello 探针
│  │  ├─ auth/                      # L1：JWT 认证
│  │  ├─ project/                   # L2：示例业务模块
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
├─ packages/money/                  # 跨端共享精度计算纯函数库（币种常量、金额/汇率舍入规则；零 IO）
├─ packages/eslint-config/          # 共享 ESLint 配置
├─ packages/typescript-config/      # 共享 tsconfig
│
├─ e2e/                             # Playwright E2E（跨前后端，独立一层）
│  ├─ modules/                      # 测试用例
│  ├─ fixtures/  helpers/           # 夹具与辅助
│  ├─ scripts/                      # E2E 运行脚本
│  └─ test-results/                 # 全部运行产物（gitignored）
│     └─ playwright-report/         # HTML 报告
│
├─ infra/compose/                   # Docker Compose + Dockerfile
├─ scripts/                         # 工程脚本（init / test / worktree）+ __tests__/
├─ changes/                         # 变更文档（需求/方案/验收，按功能分目录）
├─ docs/                            # 长期规范文档
├─ .changeset/                      # Changesets 配置与变更记录
├─ .husky/                          # git hooks
└─ .pi/skills/                      # AI 工作流技能存档
```

## ⚠️ 核心约定

- 单一职责原则（SRP）
- **禁止自己启动服务**：不允许 AI 自行启动 dev 服务，人类会自行启动
- 前后端共享类型由后端 DTO 为唯一来源，前端 `bun run generate:api` 从 OpenAPI 生成（禁止手写共享类型）；跨端共享计算逻辑进 `packages/money`（仅限纯函数）
- 根目录整洁：一次性交付文档、过程文档禁止放根目录，变更文档进 `changes/{功能名称}/`，长期规范进 `docs/`

### 文件归属规则

| 要加什么         | 放哪里                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| 新页面（公开）   | `app/<路由>/`                                                             |
| 新页面（需登录） | `app/(protected)/<路由>/`，不写任何校验代码                               |
| 新业务组件       | `components/business/<领域>/`，带 index.ts 桶文件                         |
| 跨领域复用组件   | `components/base/`（2 处以上复用才准进）                                  |
| shadcn 原语      | `bunx shadcn add`，进 `components/ui/`，不手改                          |
| 新后端模块       | `services/chat/src/<模块>/`，在 `app.module.ts` 注册一次                |
| 新共享类型       | 后端 DTO 为唯一来源，前端 `bun run generate:api` 从 OpenAPI 生成（禁止手写共享类型） |
| 跨端共享计算逻辑 | `packages/money/`（仅限纯函数：精度、舍入、币种常量；有 IO 的逻辑禁止进包）        |
| 接口测试         | `services/chat/test/api/<模块名>.spec.ts`（一个 controller 一个文件）     |
| 集成测试         | `services/chat/test/integration/<模块组合>.spec.ts`（一个业务流一个文件） |
| 单元测试         | 与源码同目录`<被测文件>.spec.ts`                                          |
| E2E 用例         | `e2e/modules/<编号>-<模块>.spec.ts`                                       |

### 组件引用规则

`business → base → ui` 单向；禁止跨领域引用；禁止 ui/base 反向引用 business。

### 测试约定

- 前端只写纯逻辑单元测试（`lib/hooks/**`）；组件层默认不写组件测试，防线是 E2E
- 测试公共工具只放 `services/chat/test/helpers/`，不在 spec 之间复制
- 测试产物只允许落在 `e2e/test-results/` 下，HTML 报告固定放 `e2e/test-results/playwright-report/`

### 质量红线（不可妥协）

- 方案必须包含完整测试设计（单元/接口/集成）
- 实施时必须真实执行测试并通过（0 failed）
- 验收报告必须包含测试执行日志/截图
- 环境受限时用 mock，但仍需跑通

**不合格的交付**（打回重做）：

- ❌ 方案缺测试章节或内容不完整
- ❌ 测试标注「未执行」或「需真实环境」
- ❌ 验收报告无测试执行证据

### 提交规范

- Conventional Commits：`type(scope): subject`，由 commitlint 强制
- 用 `bun run commit` 交互式撰写；变更用 `bun run changeset` 记录

### 文件路径引用

- ✅ `services/chat/src/project/project.service.ts:42`
- ❌ `[project.service.ts](path)` 或 `./path`
