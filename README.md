# FXPlanner-new — 全栈应用骨架

> 基于 `jiangxiaoyu66/agentbase-template` 初始化的 Bun + Turbo 全栈项目：Next.js 前端 + NestJS 后端 + Prisma + JWT 认证 + 完整测试体系。
> 项目标识已统一设置为 `FXPlanner-new`，workspace scope 为 `@fxplanner-new`。

## 特性

- 🏗 **Monorepo 工程底座**：Bun workspaces + Turbo 任务图 + 统一 tsconfig/eslint
- 🔐 **认证骨架**：注册 / 登录 / JWT Guard，开箱即用
- 🗄 **Prisma + PostgreSQL**：12-Factor 环境变量、migration、种子数据
- 🧩 **示例业务模块**：完整 CRUD（前后端 + 测试），演示标准分层，可一键删除
- ✅ **三层测试**：单元（vitest）+ 接口冒烟（supertest）+ E2E（Playwright）
- 🧹 **工程卫生**：测试产物统一收敛 `e2e/` 下，过程文档只进 `changes/`
- 📦 **版本工具链**：commitizen → commitlint → lint-staged → Changesets → git tag

## 快速开始

前置：Bun ≥ 1.2、PostgreSQL。

```bash
# 项目文件已完成初始化，无需再次拉取模板
cd FXPlanner-new

# 项目名称、workspace scope 和端口已完成初始化
# 1. 安装依赖（postinstall 自动生成 Prisma Client）
bun install

# 2. 配置环境变量
cp .env.local.example .env.local
cp clients/chat-web/.env.local.example clients/chat-web/.env.local
cp services/chat/.env.local.example services/chat/.env.local
# 编辑三个文件，填入各层本地配置

# 3. 建库 + migration + 种子数据
cd services/chat && bunx prisma migrate deploy && bun run prisma:seed && cd ../..

# 4. 启动（前端 3001 + 后端 4001）
bun run dev
```

**验证骨架是活的**：

```bash
bun run typecheck     # TypeScript 类型检查
bun run test          # 单元 + 接口冒烟（health/注册/登录/401/CRUD）
bun run test:e2e      # E2E（需先准备数据库和服务环境）
```

## 目录结构

```
├─ clients/chat-web/            # Next.js 前端（登录/注册 + 示例模块页）
├─ services/chat/               # NestJS 后端（auth + 示例模块 + health）
│  ├─ src/{auth,project,config,prisma,database}/
│  ├─ prisma/                   # schema + migrations + seed
│  └─ test/                     # 骨架接口/集成测试
├─ packages/contracts/          # 共享包（跨端类型/常量的唯一出口）
├─ packages/eslint-config/      # 共享 ESLint 配置
├─ packages/typescript-config/  # 共享 tsconfig
├─ e2e/                         # Playwright E2E（所有产物只落在此目录）
├─ infra/compose/               # Docker Compose 编排 + Dockerfile
├─ scripts/                     # 测试、代码地图与 worktree 脚本
└─ changes/                     # 变更文档（需求/方案/验收，按功能分目录）
```

## 三层结构（按删除成本分层）

| 层 | 内容 | 不需要时 |
| --- | --- | --- |
| **L1 核心骨架** | auth（JWT）、Prisma + User 表、health、env 模式、工程配置 | 保留 |
| **L2 示例模块** | project CRUD（前后端 + 测试），演示标准分层 | 手动删除：注册点唯一（`app.module.ts`），无入向依赖 |
| **L3 工具与规范** | test/code-map 脚本、版本工具链、测试体系、文档规范 | 保留 |

## PostgreSQL（macOS）

```bash
# 安装
brew install postgresql@16 && brew link --force postgresql@16

# 启动 / 停止（默认端口 5432）
brew services start postgresql@16
brew services stop postgresql@16

# 多实例不同端口：每个实例独立数据目录
initdb -D ~/pgdata/5433 -U postgres -E UTF8           # 初始化
pg_ctl -D ~/pgdata/5433 -o "-p 5433" -l ~/pgdata/5433.log start   # 指定端口启动
pg_ctl -D ~/pgdata/5433 stop

# 密码
psql -U postgres -h localhost -p 5432                 # 连接
ALTER USER postgres WITH PASSWORD 'newpassword';      -- 修改密码
# 免密/认证方式：编辑数据目录下 pg_hba.conf（trust=免密 / md5=密码），改完 pg_ctl reload
# 连接串格式：postgresql://postgres:密码@localhost:5433/库名

# 建库（供 DATABASE_URL 使用）
createdb fxplanner_new_db_local                            # 简单建库
psql postgres -c "CREATE USER fxplanner_new_user WITH PASSWORD 'xxx'; \
  CREATE DATABASE fxplanner_new_db_local OWNER fxplanner_new_user;"   # 独立账号（可选）
# → DATABASE_URL="postgresql://fxplanner_new_user:xxx@localhost:5432/fxplanner_new_db_local"

# 测试连通性
pg_isready -h localhost -p 5432                                   # 探活
psql "postgresql://user:pass@localhost:5432/库名" -c "SELECT 1;"  # 认证+权限验证

# ⚠️ 多实例下 psql/createdb 必须显式 -h localhost -p <端口>，否则默认打 5432
# ⚠️ 建库 SQL 在终端执行（或 psql -c），不要粘进 psql 交互界面
```

## 环境变量（12-Factor）

项目端口通过根目录 `.env.local` 配置，后端专属配置放在 `services/chat/.env.local`。`*.example` 进 git，实际配置不进 git。后端启动时 zod 校验，缺变量 fail-fast。

| 变量 | 位置 | 说明 |
| --- | --- | --- |
| `API_PORT` / `WEB_PORT` | 根 | 服务端口 |
| `CORS_ORIGIN` | 根 | 允许的前端源 |
| `NEXT_PUBLIC_API_BASE_URL` | 根 | 前端 → 后端地址（build 时 inline） |
| `DATABASE_URL` | services/chat | Prisma 连接串 |

## 测试约定

| 层 | 工具 | 命令 | 说明 |
| --- | --- | --- | --- |
| 后端单元 | vitest | `bun run test` | `services/chat/src/**/*.spec.ts`（与源码同目录） |
| 后端接口 | vitest + supertest | `bun run test` | `services/chat/test/api/`，一个 controller 一个 spec |
| 后端集成 | vitest + supertest | `bun run test` | `services/chat/test/integration/`，一个业务流一个 spec |
| 前端单元 | vitest | `bun run test` | 仅纯逻辑（`lib/hooks/**` 的 utils），**组件层默认不写组件测试，防线是 E2E** |
| 工具链 | bun:test | `bun run test scripts` | 工具链测试 |
| E2E | Playwright | `bun run test:e2e` | 产物只落在 `e2e/` 下 |

**铁律**：集成测试产物（报告/截图/视频/JSON）只允许落在 `e2e/` 下。

## 提交与发版

```bash
bun run commit            # 交互式写规范 commit（commitlint 拦截不合规 message）
bun run changeset         # 开发时记录变更（Markdown，进 git）
bun run version-packages  # 发版：汇总 CHANGELOG + SemVer bump
bun run release           # 打 git tag
```

所有包 `private: true`，Changesets 只做版本与 CHANGELOG 管理，不发 npm。

## 常用命令

```bash
bun run dev / build / typecheck / lint / test
bun run dev:chat          # 仅后端
bun run dev:chat-web      # 仅前端
bun run test:e2e          # Playwright
bun run test all          # 全量测试（或 bun run test 交互多选 / bun run test api web 指定套件）
```

## AI 协作

仓库内置 AI 协作规范（`AGENTS.md` / `CLAUDE.md`）：开发流程（需求→规格→方案→实现→验收）、质量红线（方案必含测试设计、验收必有执行证据）、worktree 配置。`.pi/skills/` 存档了配套的工作流技能（需求对齐、方案设计、任务分发、归档等）。
