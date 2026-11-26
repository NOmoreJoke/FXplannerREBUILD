# FXplanner — 换汇计划工作台

> **唯一工程根**：本仓库（`NOmoreJoke/FXplannerREBUILD`）是 FXplanner 的唯一 SoT；旧 Vue/FastAPI 仓不参与上线排期，其进度不计入完成度。
> 进度真相：`changes/mvp-completion/审查报告-20261103.md`（功能逐项 ✅/🟡/❌）· 迭代节奏：`docs/NOMI-FX-ITERATION-AND-BACKLOG-20261103.md` · 上线范围：`docs/NOMI-FX-CONSOLIDATION-20261103.md` §7 · 本地起服：`docs/LOCAL_BOOTSTRAP.md` · 上线预检：`docs/LAUNCH-CHECKLIST.md`

面向有分批换汇需求用户（留学缴费、跨境用汇等场景）的外汇计划与成本管理工作台。
核心闭环：**建换汇计划 → 分批准备 → 记录买入 → 记录实际使用 → 更正纠错 → 成本报告**，辅以提醒、汇率行情、AI 汇率助手。

## MVP 产品能力与交付状态

- **换汇计划**：目标币种/金额/使用日期，分配上限校验（防重复分配），目标调整预览（缺口/释放），完成、取消、重开全生命周期；首页「新建计划」直达入口、列表准备进度条、账户页按计划分配只读表（阶段5 §1-§3 收尾）
- **分批准备**：安心/均衡/主动三种节奏，临期自动降级，零头归尾，安排变更先预览后替换
- **买入交易**：本金+汇率 / 本金+到账两种互算，手续费三态（无/未知/明确，未知≠0），关联计划仅标记
- **资金使用**：分次使用，扣账户余额与计划分配，FIFO 成本消耗（初始持仓 → 买入，同日按录入顺序），准备/使用双进度与资金状态（PREPARING/READY/USED_UP）
- **更正与日志**：交易、初始持仓和使用记录更正均支持原因必填、影响预览、版本历史和账本重放（FIFO 共享内核，改小差额回未分配、改大自动补分配并留痕）。初始持仓币种更正按原时点取价。修改使用记录已于 MVP-F0-3 闭环（`T-CORR-004` 恢复，L3 待人工起服复跑）。
- **提醒**：准备日/最晚日/逾期/使用日等七类场景，同计划同日合并、逾期不重发，可关闭
- **报告**：计划/账户成本摘要（FIFO 分摊、费用未明确提示），初始持仓排除收益比较（占位枚举，算法定稿后填数值）
- **账号与数据**：个人（导出 ZIP+CSV / 账号注销）与当前组织（导出 / 清空 / 删除组织）物理双域拆分与双锁防护（7 自然日冷静期）
- **组织工作台（ToB R1）**：默认个人工作台兜底迁移、多组织创建/切换与 `X-Organization-Id` 强隔离、邮件邀请与五角色 RBAC（`OWNER`/`ADMIN`/`FINANCE`/`OPERATOR`/`VIEWER`）、同事务/拒绝 `AuditLog` 只读审计
- **汇率**：多源 Provider 抽象 + 5 分钟缓存时效，历史汇率查询，定时刷新 cron；汇率行情页与图表
- **AI 助手**：按组织与成员归属的 ReAct Agent + 汇率查询工具（最新价/历史区间），流式输出，会话持久化；AI 模型白名单管控

## 技术栈

Bun + Turbo Monorepo：Next.js（App Router）前端 / NestJS + Prisma + PostgreSQL 后端 / openapi-typescript 契约管线（后端 DTO 唯一来源，前端生成类型）/ Vitest（单元/接口/集成）+ Playwright（E2E）。

## 目录结构（权威定义见 AGENTS.md）

```
├─ clients/chat-web/            # Next.js 前端（登录/建账/首页/计划/交易/账户/更正/提醒/报告/组织工作台/设置/数据请求/AI 助手）
├─ services/chat/               # NestJS 后端（auth/organization/authorization/audit/onboarding/plan/transaction/usage/
│                                #   correction/reminder/report/rate/ai/account/data-request/home/settings/currency）
│                                #   prisma schema + migrations + MIG-B/E/F & perf CLI，三层测试在 test/
├─ packages/money/              # 跨端共享精度计算纯函数库（15 币种小数位、汇率 8 位、Decimal 舍入规则）
├─ packages/                    # dev-log-server / eslint-config / typescript-config
├─ e2e/                         # Playwright E2E（20 个 spec，107 条用例，含 15-organization 多租户 R1 全量验收）
├─ infra/compose/               # Docker 镜像 + 生产部署编排（deploy.sh）
├─ changes/                     # 变更文档（需求/方案/验收，按功能分目录）——进度事实来源
└─ docs/                        # 长期规范：VERIFY.md / FEATURE-MAP.md / ITERATION-REFACTOR-ROADMAP / handoff 交接文档
```

## 快速开始

前置：Bun ≥ 1.2、PostgreSQL（本地 Homebrew 实例即可，`scripts/db-local.sh` 统一管理）。

```bash
bun install

# 配置环境变量（三层各一份，模板见 *.example）
cp .env.local.example .env.local
cp clients/chat-web/.env.local.example clients/chat-web/.env.local
cp services/chat/.env.local.example services/chat/.env.local

# 建库 + migration + 种子数据（数据库实例由脚本拉起）
bun run db:up
cd services/chat && bunx prisma migrate deploy && bun run prisma:seed && cd ../..

# 启动（前端 3001 + 后端 4001，读取 .env.local）
bun run dev
```

## 测试

```bash
bun run test            # 交互式选择套件
bun run test all        # 全量：unit / api / integration / infra / web / money / dev-log / e2e / scripts
./e2e/scripts/run-e2e-tests.sh --headless   # E2E：自动拉起前后端 → 跑测 → 回收服务，产物收敛在 e2e/test-results/
```

质量红线：方案必含测试设计，实施必跑通（0 failed），验收必附测试日志（详见 `AGENTS.md`）。

## 部署

镜像构建与推送走 CI（`.github/workflows/docker-build.yml` + ghcr 中转 `relay-images.yml`）；生产部署编排见 `infra/compose/`（compose.prod.yaml + deploy.sh，阿里云 ECS 隔离部署 + nginx 同源反代）。

## 工程规范

- 目录结构、文件归属、组件引用、测试约定：**`AGENTS.md`（唯一权威）**
- 提交：Conventional Commits（`bun run commit`），变更记录用 Changesets
- 进度与遗留缺口：`docs/开发计划/MVP开发计划.md`（2026-11-03 审计）；各功能需求/方案/验收：`changes/<功能名>/`
