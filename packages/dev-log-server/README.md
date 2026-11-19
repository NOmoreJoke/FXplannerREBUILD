# @fxplanner-new/dev-log-server

本地开发专用的前端错误日志接收服务（仅 dev 环境运行）。

## 做什么（职责）

- 接收 `clients/chat-web` 客户端错误采集（`instrumentation-client.ts` → `lib/dev-log/monitor`，
  基于 `@sentry/browser`）上报的事件，HTTP 入口为 `POST /frontend-log`（默认 `127.0.0.1:8787`，
  可用 `DEV_LOG_PORT` 覆盖）；
- 服务端兜底脱敏：Token / Cookie / 密码 / secret 等敏感字段一律替换为 `***`
  （`src/mask.ts`，前端 `beforeSend` 已脱敏一次，这里是防御纵深）；
- 按时间落盘到本包 `logs/` 目录（运行产物，已 gitignored），供 AI 排错与本地回溯。

## 不做什么（边界）

- **不是生产监控**：不上报任何外部服务（无 Sentry SaaS / 第三方 APM 依赖），
  仅绑定 `127.0.0.1` 本地回环；
- **不参与业务逻辑**：只做接收、脱敏、写盘，不聚合、不告警、不提供查询 API；
- **不进生产运行时**：生产构建与部署不包含本包的运行时调用；其单元测试仍纳入
  统一测试入口（`scripts/test.ts` 的 `dev-log` 套件）与 CI，防止工具链漏跑。

## 为何独立成包

- 前端排错依赖「日志先行」（VIBE-CODING-PLAYBOOK：不盲猜），把采集-脱敏-落盘链路
  收敛在一个可独立测试（vitest：mask / server / time / writer 四套件）的小包里，
  避免把调试基建混入 `clients/chat-web` 业务代码；
- 与 `@fxplanner-new/money` 同理：workspace 内独立 tsconfig / 测试入口，
  由根 `scripts/test.ts` 的 `dev-log` 套件与 CI 统一执行，防止漏跑。
