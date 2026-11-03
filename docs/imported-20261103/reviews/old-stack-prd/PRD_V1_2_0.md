# FXplanner PRD V1.2.0

状态：工程验收覆盖稿（与仓库内 V1.1.2 原文联读）
日期：2026-07-29
基线：PRD V1.1.2 + 代码 `915ae2fbf905c436cca5d0f0d5249b6f1da3b0cf`

> 本文是 [`PRDs/FXplanner_PRD_V1_1_2.docx`](PRDs/FXplanner_PRD_V1_1_2.docx)（SHA-256 `f0a58253eff991085ef361884d3ee511c64af7a3ed6e2db0a3b19c2d835f404a`）的冲突覆盖与工程验收合同。未被本文修改的详细场景、合规边界、字段说明和原型证据继续沿用原文；冲突时以本文为准。

## 1. 范围

### 1.1 In

- §4.1 身份登录与首次初始化。
- §4.2 首页与全局导航。
- §4.3 虚拟外汇账户、持仓、FIFO、平账与重放。
- §4.4 文字/传统表单/CSV/语音/图片/PDF 草稿录入与批量确认。
- §4.5 换汇目标与持仓分配。
- §4.6 换汇计划、动态调整、监测与通知。
- §4.7 路径与费用比较。
- §4.8 历史模拟。
- §4.9 确定性 Base Report、积分钱包与扣减。
- §4.11 订阅、积分包与支付适配。
- §4.12 内部运营。
- §4.13 单租户小 B Workspace。
- §5 AI Harness 中的结构化草稿能力。

### 1.2 Out

| 范围 | 排除项 |
|---|---|
| AI 报告 | narrative、长文本、AI 增强、专属计费与专属 UI |
| 家庭共享 | 邀请、家庭成员、协作草稿、成员积分授权、公开 share-token |
| 资金执行 | 产品内换汇/汇款/收款/托管、银行账户连接、交易跳转 |
| 方向判断 | 汇率预测、择时、投资建议 |
| 小 B 非目标 | ERP、库存、订单、应收应付、企业审批、多法人、外部客户共享账户 |

### 1.3 外部依赖边界

| 能力 | 本地验收 | 上线前外部门禁 |
|---|---|---|
| 支付 | Fake PaymentAdapter + webhook contract | 真实商户/sandbox/签名/退款 |
| 语音/OCR | fixture adapter + canonical draft | 供应商黄金集、许可、数据落区 |
| 邮件/Web Push | fake adapter + outbox | 域名、送达率、退订 |
| 汇率/费用 | 固定 fixture + provider contract | 生产数据许可、SLA、质量运营 |

## 2. 产品与合规不变量

1. 金额只使用 Decimal；API 使用十进制字符串 + ISO 4217。
2. 确定性引擎拥有正式金额；AI 只输出 Draft。
3. 正式写入必须用户确认、校验资源版本并具备幂等键。
4. LedgerEntry、CreditLedgerEntry、AuditEvent 只追加，不物理删除。
5. 未知费用不得存储为 0；缺失时阻断确定性排名或显式降级。
6. 真实准备进度只含已确认且已分配的目标币种持仓。
7. FIFO 消耗顺序固定；加权平均成本只展示。
8. 不存在与越权统一返回 404；跨租户资源不得泄露存在性。
9. 产品不执行交易，不预测方向，不推荐买入时机。
10. 生产迁移、部署、真实支付和真实用户数据不属于本地验收。

## 3. Canonical IA

| Route | 页面 | 关键子状态 |
|---|---|---|
| `/` | Landing | 默认、登录 CTA |
| `/login` | Auth | login、error、onboarding、session-expired |
| `/app/home` | Home | empty、loading、partial-error、ready |
| `/app/input` | Input | method、form、text、CSV、voice、image/PDF canonical Draft |
| `/app/input/review` | Draft Review | parsing、batch-error、review、confirm |
| `/app/accounts` | Accounts | empty、list、entry drawer |
| `/app/accounts/:id` | Ledger | summary、entries、lots、reconcile、replay |
| `/app/goals` | Goals | empty、list、create |
| `/app/goals/:id` | Goal Detail | risk、allocation、pending、failed、ready |
| `/app/plans/:id` | Plan Detail | confirm、adjust、stale、completed |
| `/app/routes` | Route Compare | calculating、expired、no-ranking、completed |
| `/app/simulation` | History Replay | calculating、failed-released、completed |
| `/app/reports` | Base Reports | list、generating、failed-released、insufficient |
| `/app/reports/:id` | Base Report | HTML、download、facts-updated |
| `/app/settings` | Settings | account、locale、theme、notification |
| `/app/settings/billing` | Billing | plans、processing、success、failure |
| `/app/settings/credits` | Credits | buckets、reservations、ledger |
| `/ops/*` | Ops Console | users、data、audit、dry-run |
| `/workspace/*` | Small-B | dashboard、org、accounts、costs、goals、reports、audit |

Legacy：

| 旧路由 | 兼容行为 |
|---|---|
| `/dashboard` | redirect `/app/home` |
| `/transactions` | redirect `/app/accounts`，保留 query |
| `/strategies` | redirect 最近 Plan 或 `/app/goals` |
| `/subscriptions` | redirect `/app/settings/billing` |

主导航仅 Home、Accounts、Plans、Routes、Simulation、Reports、Settings。Billing/Credits 位于账户/Settings；Ops/Workspace 使用独立 Shell。

## 4. DDD Context Map

| Context | Aggregate Root | 事实 |
|---|---|---|
| Identity | User、Session | 登录、初始化、locale、时区 |
| Ledger | FxAccount | Entry、Lot、余额、成本、平账 |
| Goal/Planning | Goal、Plan | 分配、Safety Date、步骤、调整 |
| Market Data | RateSnapshot、FeeCatalogVersion | 来源、时间、质量、费用 |
| Route | RouteComparison | 路径腿、总成本、排序、过期 |
| Simulation/Report | SimulationRun、BaseReport | 输入快照、结果、制品 |
| Credits/Billing | CreditWallet、PaymentOrder | 桶、预占、核销、权益、支付 |
| Notification | Notification | 提醒事实、读状态 |
| Ops/Audit | AuditEvent、DryRunJob | 管理动作与不可变审计 |
| Workspace | Organization | 租户、角色、组织资产 |
| Canonical Draft Input | InputDraft | 原始证据、字段、置信度、确认 |

同步事务：Ledger、Goal/Plan 版本、Credits/Payment。
Outbox：通知、投影、异步模拟、制品渲染、外部 adapter。

## 5. 功能合同

### 5.1 身份与初始化（PRD §4.1）

| 项 | 规则 |
|---|---|
| 登录 | 微信 OAuth、邮箱 OTP；开发测试登录受 `DEBUG` + flag 限制 |
| 初始化 | region=HK、baseCurrency、timezone、locale、age confirmation |
| Session | access + HttpOnly refresh；idle/session expiry 可恢复 returnUrl |
| API | 新 `/api/v1/auth/*`；旧 `/auth/*` facade 保留 |
| 状态 | login、code-error、onboarding、session-expired |
| 验收 | state/nonce、OTP 限流、refresh rotation、logout revoke、open redirect 拒绝 |

### 5.2 首页与导航（PRD §4.2）

| 项 | 规则 |
|---|---|
| Read Model | accountSummary、goalSummary、alerts、entitlement；含 `asOf/sourceVersions` |
| 降级 | AI、报告、支付失败不得阻断账户/目标摘要 |
| CTA | 每次只显示一个主行动：创建目标/录入换汇/处理提醒 |
| 恢复 | query 保存筛选与返回上下文；主题/locale 可 localStorage |
| 验收 | empty/loading/partial-error；键盘导航；active nav；局部失败 |

### 5.3 Ledger（PRD §4.3）

| 项 | 规则 |
|---|---|
| Account | 按持有币种；owner/organization 二选一；币种建立后不可变 |
| Entry | draft -> confirmed；confirmed append-only；correction 引用原 entry |
| 时序 | 同账户 confirmed `occurredAt` 必须严格晚于最后一条 confirmed entry；相同或更早时间返回 `LEDGER_CHRONOLOGY_CONFLICT`；导入确认前必须消解时间冲突 |
| Lot | 换入创建；换出/支出 FIFO 消耗；费用随腿和 lot 分配 |
| Balance | confirmed in - out - spend + correction；禁止负余额 |
| Cost | remainingCost = lot cost sum；weightedAverage 仅展示 |
| Reconcile | 输入 closingBalance，只报告差异；不得自动生成修正 |
| Replay | workspace 隔离；相同输入/版本产生相同哈希；不写正式表 |
| API | `/api/v1/ledger/accounts`；`/accounts/{id}/drafts`；`/accounts/{id}/drafts/{draftId}/confirm`；`/accounts/{id}/imports`；`/accounts/{id}/reconciliations`；`/accounts/{id}/replays` |
| Error | `LEDGER_NOT_FOUND`、`LEDGER_NEGATIVE_BALANCE`、`LEDGER_FEE_UNKNOWN`、`LEDGER_VERSION_CONFLICT` |
| 验收 | FIFO golden、partial lot、fee、multi-hop、rounding、ownership、idempotency |

### 5.4 低摩擦录入（PRD §4.4）

| 输入 | 本地合同 |
|---|---|
| Text/Form | 本地 canonical parser；解析失败不得生成可确认草稿 |
| CSV | 固定 `kind,amount,unitCost,fee,occurredAt` V1 模板；最多 500 行；逐行错误；`/imports` 全批确认原子性与批次冪等 |
| Voice | 浏览器支持时使用即时听写；否则 audio + 用户确认逐字稿；音频原始位元组 SHA-256 -> Draft |
| Image/PDF | object + 用户确认 OCR 文字；原始位元组 SHA-256 -> Draft；未配置 OCR provider 时不得声称自动识别 |

Draft 必含 `sourceType`、`sourceHash`、`detectedLocale`、`fields`、`confidence`、`evidenceSpans`、`expiresAt`、`version`。
金额/币种/方向歧义、低置信度、约数必须待确认。Confirm 时重校验账户版本与所有领域不变量。
CSV 批次的任一领域错误必须回滚全部 entry/draft/lot/consumption/outbox；同一 idempotency key + 同一 payload 返回原结果，不同 payload 返回冲突。

### 5.5 Goal 与分配（PRD §4.5）

| 项 | 规则 |
|---|---|
| Goal | targetCurrency、targetAmount、useDate、riskPreference、status、version |
| Safety Date | useDate - settlement - transfer - business days - buffer |
| Allocation | 同一 lot 可部分分配；跨目标总分配不得超过剩余 lot |
| Progress | 仅已确认目标币种 allocation / targetAmount |
| 状态 | draft -> pending_plan -> active -> completed/reopened/cancelled |
| API | `/api/v1/goals`、`/{id}/allocations`、`/{id}/reopen` |
| 验收 | 超分配、并发版本、终态、reopened、Safety Date |

### 5.6 Plan、动态调整与监测（PRD §4.6）

| 项 | 规则 |
|---|---|
| Plan | 每 Goal 只有一个 active version；旧版本不可变 |
| Step | amount、dueDate、status、reasonCode；总覆盖守恒 |
| Adjustment | 事实变化产生 Draft + before/after diff；用户确认后生效 |
| Protection | 临近 Safety Date 优先可靠、简单路径，不预测方向 |
| 状态 | draft、pending_confirm、active、stale、completed、failed |
| Notification | 事实型、非焦虑文案；outbox 幂等 |
| API | `/api/v1/plans`、`/{id}/adjustments`、`/{id}/confirm` |
| 验收 | stale、并发、完成、reopen、提醒去重 |

### 5.7 Route 与费用（PRD §4.7）

| 项 | 规则 |
|---|---|
| Path | direct 或一个中间币种；每腿独立 rate/fee/source/time |
| Cost | rate spread + transfer/platform/bank fee；未知不可按 0 |
| Rank | deterministic comparator；到期保障/可靠度先于理论最低成本 |
| Snapshot | quoteExpiresAt、rateVersion、feeVersion、confidence |
| 状态 | calculating、completed、expired、no_reliable_ranking |
| API | `/api/v1/routes/compare`、`/api/v1/routes/{id}` |
| 验收 | 费用未知、过期、tie-break、multi-hop、source freshness |

### 5.8 历史模拟（PRD §4.8）

| 项 | 规则 |
|---|---|
| 方案 | 一次性、等额分批、按安全日追赶、实际计划 |
| 数据 | 只能使用历史时点当时可得数据；禁止未来数据 |
| 结果 | totalCost、weightedRate、fees、maxShortfall、completionDate |
| 任务 | accepted -> calculating -> completed/failed_released |
| 计费 | 预占；成功制品核销；失败全部释放 |
| API | `/api/v1/simulations/preview|runs|{id}` |
| 验收 | same snapshot same hash、no-lookahead、失败释放、超时恢复 |

### 5.9 Base Report 与 Credits（PRD §4.9）

Base Delivery Standard：

- 不可变输入快照。
- 账户/目标摘要。
- 确定性路径与费用表。
- 数据来源/时间/计算版本。
- 历史模拟结果（适用时）。
- 免责声明。
- HTML/PDF/CSV 制品及内容哈希。

不含 AI narrative。`facts_updated` 只改变 basis status，不改历史制品。

| Credits | 规则 |
|---|---|
| Bucket | free_grant、carry_subscription、current_subscription、purchase |
| 顺序 | `expires_at ASC NULLS LAST`；同到期按固定 source 顺序 |
| Reservation | allocation 到具体 bucket；consume/release 按原 allocation |
| Price Quote | 默认 15 分钟；预占成功锁价；过期必须重新确认 |
| API | `/api/v1/reports/*`、`/api/v1/credits/*` |
| 验收 | 余额可重算、重复请求、并发预占、精确释放、制品哈希 |

### 5.10 家庭共享（PRD §4.10）

本版本 OUT。现有公开 share-token：

- 不生成新 token。
- 未认证访问统一 404。
- feature flag 默认关闭。
- 代码暂保留兼容；未来删除需独立迁移与批准。

### 5.11 订阅、积分包与支付（PRD §4.11）

| 项 | 规则 |
|---|---|
| Order | created -> processing -> succeeded/failed/cancelled/refunded/disputed |
| Adapter | domain 不依赖供应商 SDK；本地 `FakePaymentAdapter` |
| Webhook | 原始 body 验签；event id 幂等；金额/币种/product/metadata 全校验 |
| Fulfillment | webhook-first；订单与权益/积分同事务；不可由前端 success 触发 |
| Refund | 只反向原订单未消费权益；已消费进入 dispute，不模糊减余额 |
| API | `/api/v1/payments/checkout|orders|webhooks/{provider}` |
| 验收 | 签名失败、重复/乱序、金额不符、未知订单、退款 |

### 5.12 Internal Ops（PRD §4.12）

| 项 | 规则 |
|---|---|
| Auth | consumer role 不进入 `/ops`；默认拒绝 |
| 角色 | support、data_ops、finance_ops、admin；最小权限 |
| 动作 | 默认 read-only；高风险仅 dry-run/fake；双人复核接口保留 |
| Audit | actor、role、reason、target、beforeHash、afterHash、result、requestId |
| 禁止 | 直接改余额、账本、确定性结果、真实支付状态 |
| API | `/api/v1/ops/{users,data,fees,reports,payments,privacy,audit,dry-runs}` |
| 验收 | RBAC 矩阵、越权、审计不可改、dry-run 无领域写入 |

### 5.13 Small-B Workspace（PRD §4.13）

| 项 | 规则 |
|---|---|
| Tenant | Organization；所有业务 Repository 必须接收 tenant context |
| 角色 | owner、admin、operator、viewer |
| 能力 | 组织自有 Ledger、Cost Center、Goal、Route、Base Report、Audit |
| 隔离 | 每表 `organization_id`；跨租户统一 404 |
| OUT | 外部客户账户、客户邀请/grant、家庭式协作、企业审批 |
| API | `/api/v1/organizations/*` |
| 验收 | tenant isolation、角色矩阵、审计、组织/个人资产不串读 |

## 6. AI Harness（PRD §5）

| 合同 | 规则 |
|---|---|
| Canonical Schema | 版本化、严格字段、额外字段拒绝/隔离 |
| Provider | adapter；超时、重试、熔断、主备；不在领域层 |
| Evidence | transcriptSpan/sourceHash/confidence/model/version |
| Permission | 只创建/更新未确认 Draft |
| Confirm | current user + resource version + idempotency + domain validation |
| Retention | 原始音频默认转写后删除；fixture 不含真实个人数据 |
| Test | schema、prompt injection、低置信、供应商失败、AI 直接写入拒绝 |

## 7. API、错误与数据

### 7.1 兼容

- 新能力只增加 `/api/v1` endpoint/可选字段。
- 删除/改名、金额语义、必填收紧、枚举含义变化才进入 `/api/v2`。
- 旧 v1 facade 保持 contract；客户端容忍未知可选字段。

### 7.2 ErrorCode

`AUTH_*`、`LEDGER_*`、`GOAL_*`、`PLAN_*`、`ROUTE_*`、`SIMULATION_*`、`REPORT_*`、`CREDIT_*`、`PAYMENT_*`、`OPS_*`、`ORG_*`。

响应：

```json
{
  "errorCode": "LEDGER_VERSION_CONFLICT",
  "messageKey": "errors.ledger.versionConflict",
  "requestId": "uuid",
  "details": {}
}
```

### 7.3 Expand-Contract

1. Expand：additive migration；不删旧表/字段。
2. Validate：fixture/backfill dry-run；余额/成本/桶/租户守恒。
3. Switch：feature flag 切换读取；旧 facade 保持。
4. Contract：独立批准、备份、UAT 24h 后才可删除。

## 8. 主题、语言与可访问性

| 项 | 门禁 |
|---|---|
| Locale | 每个 P0 状态 `zh-HK`、`en-HK`；保留现有 zh-CN/EN/ja 资产 |
| Theme | Light/Dark 同功能、同状态、同信息层级 |
| Money | `$26.99 CAD` / `$200 USD` / `¥141.87`；tabular figures |
| Keyboard | skip link、landmark、focus ring、modal focus trap/restore |
| Error | 非颜色表达；`aria-live`；关联字段 |
| Motion | `prefers-reduced-motion`；只用 transform/opacity |
| Responsive | desktop 1440/1280、tablet、最小 1024 产品宽度；关键表可横向滚动 |
| WCAG | 关键路径 WCAG 2.2 AA |

## 9. 自动验收

| 层 | 必跑 |
|---|---|
| Backend static | ruff、mypy、strict warning |
| Backend unit | Decimal、FIFO、状态机、权限、幂等、错误码 |
| Contract | OpenAPI snapshot、legacy consumer、adapter |
| Integration | PostgreSQL 约束/锁/事务、Redis 票据/限流、Alembic 隔离升级/回退 |
| Frontend | Vitest、vue-tsc、production build、compliance lint |
| Browser mock | 全状态、Light/Dark、zh-HK/en-HK、键盘、响应式 |
| Browser real local | Auth -> Account -> Confirm Entry -> Goal -> Plan -> Route -> Simulation -> Base Report -> Credits |
| Security | ownership、tenant isolation、webhook、AI 无写权、share closed |

跳过项、mock、fake 和未配置 provider 必须单独列出，不得合并为“全部通过”。

## 10. 发布门禁

- 仅本地代码通过 ≠ UAT/生产。
- 生产迁移、部署、真实支付、真实用户数据操作需独立授权。
- 身份、支付、数据许可、香港法律文本、对象存储、邮件、AI/OCR、灾备任一外部门禁未通过，对应 feature flag 保持关闭。
- 每个能力域具有 owner、监控、回滚、SLO 和审计证据。

## 11. 原型验收矩阵

原型采用双层验收：

- 01–20：10 个核心业务页面的 Light/Dark 高保真主链路，默认 zh-HK。
- 21–24：Light/Dark × zh-HK/en-HK 的状态矩阵，每个状态均以独立视觉行呈现。
- 每个主链路页面内置 `Route Contract` context，冻结 canonical route、主行动与恢复路径；真实点击跳转由前端 Router + Playwright 验收。

| 模块 | 必须状态 |
|---|---|
| Auth | login、code-error、onboarding、session-expired |
| Home | empty、loading、partial-error、ready |
| Input | method、parsing、batch-error、review、success |
| Goal | setup、risk、allocation、pending、failed、ready |
| Plan | confirm、adjust、stale、completed |
| Route | calculating、expired、no-ranking、completed |
| Simulation | calculating、failed-released、completed |
| Reports | list、generating、failed-released、insufficient、view |
| Billing | plans、processing、success、failure |
| Credits | summary、ledger、reservation |
| Ops | denied、dashboard、audit、dry-run |
| Workspace | dashboard、members/roles、accounts、costs、audit |

Family Sharing 与 AI narrative frames 归档，不删除，不进入 V1.2.0 验收流。
