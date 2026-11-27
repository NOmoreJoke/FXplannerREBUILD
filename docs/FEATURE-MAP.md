# FXplannerREBUILD Feature Map（用户视角功能与验证地图）

> 目标：为人类与 Agent 建立共享词汇表与确定性运行时验证入口，避免重复探索页面入口或自建临时脚本。
> 维护：凡新增/修改页面路由、核心交互流或 E2E 用例，必须同步更新本表。

| Feature | 用户路由 / 入口 | 确定性验证（E2E / 单测） | 关键红线 / 已知陷阱 |
| --- | --- | --- | --- |
| 落地页与合规展示 | `/` | `e2e/modules/06-navigation.spec.ts` | 最小合规免责声明必须真实可见（非注释）；金额格式 `$200 USD`，禁货币代码前置 |
| 登录 / 注册 / OTP | `/login`, `/register` | `e2e/modules/01-auth.spec.ts`, `05-otp-login.spec.ts` | 保护区守卫统一在 `app/(protected)/layout.tsx`，业务页不手写鉴权 |
| 首次建账向导 | `/onboarding` | `e2e/modules/08-onboarding-wizard.spec.ts`, `10-initial-backfill.spec.ts` | 初始持仓与回补需保持 FIFO 账本一致性 |
| 首页与账户视图 | `/home` | `e2e/modules/02-account.spec.ts` | 聚合数据来自后端契约，禁止前端手写共享 DTO |
| 换汇计划与排期 | `/plans`, `/plans/new`, `/plans/[id]` | `e2e/modules/03-plan.spec.ts`, `07-plan-lifecycle.spec.ts`, `11-plan-usage.spec.ts` | 金额/汇率换算走 `@fxplanner-new/money` 纯函数 + `fast-check` 属性测试；`/plans/new?fromDraft=1` 须校验 `sourceOrgId === activeOrgId` 并按最新 `caps.maxAllocatable` 重算拦截超额旧草稿 |
| 交易与使用记录 | `/transactions/new` | `e2e/modules/04-transaction.spec.ts` | 消耗计算须遵守 FIFO 不变量 |
| 更正与账本重放 | `/corrections/new`（`targetType`/`targetId` 参数） | `e2e/modules/11-correction.spec.ts`, `11-correction-quote.spec.ts`, `11-usage-correction-history.spec.ts` | 更正日志幂等且不可篡改；涉及旧版迁移需跑差分测试 |
| 市场汇率与图表 | `/market` | `e2e/modules/13-market.spec.ts` | 汇率三源路由与精度不可引入 IEEE-754 浮点漂移 |
| 提醒与报告导出 | 报告页 / 提醒入口 | `e2e/modules/11-reminders.spec.ts`, `11-reports.spec.ts` | 核对报告金额格式与打印视图 |
| 用户设置与数据请求 | `/settings`（个人/组织设置 + 个人/组织数据）、`/data-requests`（双域进度） | `e2e/modules/09-settings-preferences.spec.ts`, `12-account-data.spec.ts`, `organization-data-lifecycle.spec.ts`, `clients/chat-web/components/business/account-data/request-progress.spec.tsx` | 数据请求需持双锁守卫（个人账号注销锁 / 组织数据锁）；导出 CSV 已防公式注入；组织域撤回/下载按权限点与 `DataRequestViewDto.isRequester` 双重门控 |
| 组织工作台、成员与审计 | `/organization`, `/organization/members`, `/organization/audit`, `/invitations/[token]` | `e2e/modules/15-organization.spec.ts` (32 cases), `services/chat/test/api/organization-matrix.spec.ts` (409 cases) | W30 MIG-D 起组织业务路由必须携带 `X-Organization-Id`（缺头 400 `ORGANIZATION_REQUIRED`）；前端严禁持久化 `role`/`capabilities` |
| AI 助手与可控组织 Agent | `/chat`（侧栏「AI 助手」）→ 草稿跳转 `/plans/new?fromDraft=1` | `services/chat/src/ai/tools/agent-tools.spec.ts`, `services/chat/test/integration/agent-tool-authorization.spec.ts`, `services/chat/test/api/ai-chat.spec.ts`, `e2e/modules/14-ai-chat.spec.ts`, `e2e/modules/16-agent-organization.spec.ts` | 组织工具（账户/敞口/成本/待办/草稿）全走 `tool-guard` 先鉴权后验参（双锁+Membership+RBAC+`AuditLog(AGENT)`）；全 `.strict()` zod 无 `orgId`/`userId` 参数；支持 `AI_ORG_TOOLS_ENABLED=false` 独立降级；`draft_fx_plan` 仅调 preview、确认带 `agentRunId` 入审计；AI 禁止自行启动本地服务 |

## 常用验证命令（廉价先行）
```bash
# L1: 静态护栏（ESLint 架构边界 + 全包 0-warning enforce + 结构守卫 + 组织隔离守卫 + 类型检查）
bun run lint && bun run typecheck

# L1+: 单元与属性测试
bun run test unit web scripts money dev-log

# L2: 接口与集成测试（含 409 条跨租户全矩阵）
bun run test api integration infra
bun run --cwd services/chat test test/api/organization-matrix.spec.ts

# L3: 真实浏览器 E2E（需确认人类已启动本地服务；跑完提交前清理产物）
bun run test:e2e -- e2e/modules/<用例文件>
rm -rf e2e/test-results
```
