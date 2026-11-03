# 本地引导手册（LOCAL_BOOTSTRAP）

> 目标：任何人（含工程 bot）能从干净状态起服到登录成功。
> 端口约定**写死**：前端 `3001`、后端 `4001`、dev-log `8787`、PostgreSQL `5432`。
> 生成：2026-11-03（Iteration B / P0-7）。对照 `docs/NOMI-FX-ITERATION-AND-BACKLOG-20261103.md`。

## 0. 前置

- macOS + Homebrew + Bun ≥ 1.3（`curl -fsSL https://bun.sh/install | bash`）
- Node ≥ 20（`tsx`/`openapi-typescript` 等经 bunx 运行）
- 仓库：`NOmoreJoke/FXplannerREBUILD`，分支 `dev`

```bash
git clone https://github.com/NOmoreJoke/FXplannerREBUILD.git
cd FXplannerREBUILD
bun install
```

## 1. 数据库（本机 Homebrew PostgreSQL，无 Docker）

`scripts/db-local.sh` 以 `services/chat/.env.local` 的 `DATABASE_URL` 为唯一配置源（密钥不硬编码、不输出）。

```bash
bash scripts/db-local.sh up      # 安装（如缺失）+ 初始化 + 启动 + 建库
bash scripts/db-local.sh status  # 查看实例与端口状态
bash scripts/db-local.sh down    # 停止本项目数据目录实例
```

## 2. 三份 `.env.local`（已存在则**勿覆盖**，只按此核对键名）

| 文件 | 关键键 | 说明 |
| --- | --- | --- |
| `./.env.local`（根） | `WEB_PORT=3001` `API_PORT=4001` `CORS_ORIGIN=http://localhost:3001` `NEXT_PUBLIC_API_BASE_URL` `DEV_LOG_PORT=8787` `AI_PROVIDER_AIGYSD_*`（AI 助手，可选） | `bun run dev` / playwright.config 读取 |
| `services/chat/.env.local` | `DATABASE_URL` `JWT_SECRET` `OTP_CODE_SECRET` `SMTP_*`（OTP 邮件）`ALIYUN_*`（短信，可选）`SEED_DEMO_PASSWORD` | 后端专属；模板见 `.env.local.example` |
| `clients/chat-web/.env.local` | `NEXT_PUBLIC_SENTRY_DSN` `NEXT_PUBLIC_ANALYTICS_ID` | 前端专属（本地可留空值键） |

新建环境时：**复制 example 后从密钥服务/环境变量填值**，密钥不进 git、不进聊天记录。
本地 OTP 可用 `OTP_EMAIL_MOCK=true`（注册响应直接返回 devCode，E2E 即此模式）。

## 3. 数据库结构初始化

```bash
cd services/chat
bunx prisma migrate deploy   # 应用全部迁移
bunx prisma generate         # 生成 Prisma Client（bun install 后通常已自动）
bun run prisma:seed          # 币种表 15 币种 seed
```

## 4. 起服（开发态）

```bash
# 仓库根目录（dotenv -e .env.local 注入端口等，turbo 并行拉起前后端 + dev-log-server）
bun run dev
```

健康检查：

```bash
curl -sf http://localhost:3001/          # 前端落地页 200
curl -sf http://localhost:4001/api/health # 后端探针 200
```

后端 dev 日志：`services/chat/logs/dev.log`（`clean:logs` 清理）。

## 5. 走到「登录成功」

1. 打开 `http://localhost:3001/register`：邮箱 + 密码注册（勾选条款与 18 岁确认）。
2. 验证码：`OTP_EMAIL_MOCK=true` 时注册/登录响应体直接含 `devCode`；真实模式查邮箱。
3. 登录后进入 `/onboarding` 两步建账向导（本位币 + 初始持仓）→ 完成后落 `/home`。
4. 首页「录入买入」/「新建计划」开始使用；账户详情页可见「计划分配」只读表。

## 6. 测试与质量门

| 命令 | 范围 |
| --- | --- |
| `bun run typecheck`（turbo 全仓） | 类型检查 |
| `cd services/chat && bun run test` | 后端全量（vitest，需 DB 起） |
| `./e2e/scripts/run-e2e-tests.sh --headless` | E2E 全量（脚本自管前后端生命周期与环境变量注入） |
| `./e2e/scripts/run-e2e-tests.sh --headless --grep "T-PLAN-LC"` | 只跑匹配用例 |
| `cd packages/money && bun run test` | 跨端金额精度纯函数库 |

E2E 产物只进 `e2e/test-results/`（gitignored）。脚本退出时自动回收 3001/4001/8787 端口进程。

## 7. 契约管线（改后端 DTO 后必跑）

```bash
cd clients/chat-web && bun run generate:api
```

产出 `lib/api/openapi.json`（提交入库供 review）+ `lib/api/schema.gen.ts`（生成物，禁止手改）。
前端类型禁止手写共享类型（AGENTS.md）。

## 8. 常见问题

- **端口被占**：`lsof -nP -iTCP:3001 -sTCP:LISTEN` 查进程；E2E 脚本启动前会自动清理。
- **后端 409 ONBOARDING_NOT_COMPLETED**：写接口需先完成建账向导（BE-03 语义，非 bug）。
- **E2E 触发 429**：E2E 脚本已注入 `AUTH_THROTTLE_LIMIT=200` 等放大值；手跑单 spec 请自行 export。
- **Prisma 报 schema 与迁移不一致**：`bunx prisma migrate dev` 在本地开发分支生成新迁移后提交。
