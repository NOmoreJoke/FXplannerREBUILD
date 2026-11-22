# FXplannerREBUILD Feature Map（用户视角功能与验证地图）

> 目标：为人类与 Agent 建立共享词汇表与确定性运行时验证入口，避免重复探索页面入口或自建临时脚本。
> 维护：凡新增/修改页面路由、核心交互流或 E2E 用例，必须同步更新本表。

| Feature | 用户路由 / 入口 | 确定性验证（E2E / 单测） | 关键红线 / 已知陷阱 |
| --- | --- | --- | --- |
| 落地页与合规展示 | `/` | `e2e/modules/06-navigation.spec.ts` | 最小合规免责声明必须真实可见（非注释）；金额格式 `$200 USD`，禁货币代码前置 |
| 登录 / 注册 / OTP | `/login`, `/register` | `e2e/modules/01-auth.spec.ts`, `05-otp-login.spec.ts` | 保护区守卫统一在 `app/(protected)/layout.tsx`，业务页不手写鉴权 |
| 首次建账向导 | `/onboarding` | `e2e/modules/08-onboarding-wizard.spec.ts`, `10-initial-backfill.spec.ts` | 初始持仓与回补需保持 FIFO 账本一致性 |
| 首页与账户视图 | `/home` | `e2e/modules/02-account.spec.ts` | 聚合数据来自后端契约，禁止前端手写共享 DTO |
| 换汇计划与排期 | `/plans`, `/plans/new`, `/plans/[id]` | `e2e/modules/03-plan.spec.ts`, `07-plan-lifecycle.spec.ts`, `11-plan-usage.spec.ts` | 金额/汇率换算走 `@fxplanner-new/money` 纯函数 + `fast-check` 属性测试 |
| 交易与使用记录 | `/transactions/new` | `e2e/modules/04-transaction.spec.ts` | 消耗计算须遵守 FIFO 不变量 |
| 更正与账本重放 | `/corrections/new`（`targetType`/`targetId` 参数） | `e2e/modules/11-correction.spec.ts`, `11-correction-quote.spec.ts`, `11-usage-correction-history.spec.ts` | 更正日志幂等且不可篡改；涉及旧版迁移需跑差分测试 |
| 市场汇率与图表 | `/market` | `e2e/modules/13-market.spec.ts` | 汇率三源路由与精度不可引入 IEEE-754 浮点漂移 |
| 提醒与报告导出 | 报告页 / 提醒入口 | `e2e/modules/11-reminders.spec.ts`, `11-reports.spec.ts` | 核对报告金额格式与打印视图 |
| 用户设置与数据请求 | 设置页（导出/清空/注销） | `e2e/modules/09-settings-preferences.spec.ts`, `12-account-data.spec.ts` | 数据请求需持全局锁，防并发脏写 |
| AI 助手对话 | 侧栏 / AI 会话入口 | `e2e/modules/14-ai-chat.spec.ts` | 依赖配额与汇率工具契约，AI 禁止自行启动本地服务 |

## 常用验证命令（廉价先行）
```bash
# L1: 静态护栏（ESLint 架构边界 + 结构守卫 + 类型检查）
bun run lint && bun run typecheck

# L1+: 单元与属性测试
bun run test unit web scripts money dev-log

# L2: 接口与集成测试
bun run test api integration infra

# L3: 真实浏览器 E2E（需确认人类已启动本地服务；跑完提交前清理产物）
bun run test:e2e -- e2e/modules/<用例文件>
rm -rf e2e/test-results
```
