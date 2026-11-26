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
│  │     ├─ organization/           #     ToB R1：组织信息/成员与邀请/审计分页
│  │     ├─ invitations/[token]/    #     ToB R1：受邀摘要与接受/拒绝（登录后回跳）
│  │     ├─ data-requests/          #     数据请求进度页（个人 + 当前组织双域分区；不依赖组织上下文的豁免路由）
│  │     └─ projects/               #     示例业务页
│  ├─ components/
│  │  ├─ ui/                        # shadcn 原语
│  │  ├─ base/                      # 项目级基础组件
│  │  └─ business/<domain>/         # 业务组件（按领域分目录）
│  ├─ hooks/                        # 自定义 hooks
│  ├─ lib/
│  │  ├─ api/                       # 后端 API 客户端（个人域请求带 skipOrganizationScope，不注入组织头）
│  │  ├─ hooks/                     # 数据 hooks（组织上下文 / 权限消费 / 查询闸门；页面与组件不裸写 useEffect）
│  │  ├─ auth/                      # 会话上下文重置、回跳地址白名单与跳转、token cookie
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
│  │  ├─ organization/              # ToB R1：组织、成员、邀请、组织设置与默认组织回填
│  │  ├─ authorization/             # ToB R1：ActorContext、纯函数权限策略、组织上下文/权限/双锁 Guard 与白名单装饰器
│  │  ├─ audit/                     # ToB R1：审计同事务 writer 与只读分页查询（无 update/delete 接口）
│  │  ├─ account/                   # 账户与分配只读视图
│  │  ├─ ai/                        # AI 助手（会话、配额、汇率工具）
│  │  ├─ correction/                # 更正与账本重放（FIFO）
│  │  ├─ currency/                  # 币种清单下发
│  │  ├─ data-request/              # 数据请求与双锁判定实现（个人账号锁 / 组织数据锁；导出/清空/注销）
│  │  ├─ home/                      # 首页聚合
│  │  ├─ onboarding/                # 首次建账向导（初始持仓）
│  │  ├─ plan/                      # 换汇计划（排期、分配、变更日志）
│  │  ├─ rate/                      # 汇率（三源路由、窗口、图表缓存）
│  │  ├─ reminder/                  # 提醒
│  │  ├─ report/                    # 报告与成本核算
│  │  ├─ settings/                  # 用户设置
│  │  ├─ transaction/               # 交易（买入/卖出记录）
│  │  ├─ usage/                     # 使用记录与消耗计算（FIFO）
│  │  ├─ config/                    # env 加载与 zod 校验（12-Factor）
│  │  └─ prisma/                    # PrismaService
│  ├─ prisma/                       # schema + migrations + seed
│  │  ├─ migrations/               # Prisma 版本化迁移
│  │  │  ├─ 20261120090000_rate_cache_migration_receipt/ # 汇率缓存迁移完成记录与行归属
│  │  │  ├─ 20261120091000_rate_cache_canonical_write/ # 记录可信的汇率回源写入
│  │  │  ├─ 20261126190000_tob_r1_mig_e_tighten_constraints/ # ToB R1 MIG-E：NOT NULL / ON DELETE RESTRICT / 删旧用户唯一索引
│  │  │  └─ 20261126191000_tob_r1_mig_f_drop_legacy_columns/ # ToB R1 MIG-F：删 8 表旧 user_id、UserSettings 旧账本列、reminders.read_at，重命名 requester_user_id
│  │  ├─ rate-cache-migration/      # 旧汇率缓存迁移运维 CLI（B2；README 见目录内）
│  │  └─ tob-r1-migration/          # ToB R1 MIG-B/E/F 回填、核对与 §14.5 P6 基准 CLI（benchmark-p6.ts / README 见目录内）
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
├─ scripts/                         # 工程脚本（init / test / worktree / check-structure / check-org-scope / lint-observe）+ __tests__/（bun test：工具链与跨包一致性对照）
├─ changes/                         # ⛔ 变更文档唯一位置（需求/方案/验收），按功能名称分目录
│  ├─ tob-agent-workspace/          # ToB 组织工作台与 Agent 需求和技术方案
│  └─ realtime-rate/                # MVP-F0 汇率回补与缓存迁移实施底稿（Goal #1 任务 B/C 执行口径）
├─ docs/                            # 长期规范文档
│  ├─ VERIFY.md                     # 验证驱动、属性/差分测试与 Diff 触发防回归规范
│  ├─ FEATURE-MAP.md                # 用户视角功能与确定性验证入口地图
│  ├─ ITERATION-REFACTOR-ROADMAP-20261119.md # 迭代与重构总方案（MVP-F0/F1/F2 → ToB R1/R2）
│  ├─ VIBE-CODING-PLAYBOOK.md       # 基于本仓工具链的 Vibe Coding 最佳实践手册
│  └─ handoff/                      # 跨会话交接（OVERNIGHT-* / GOAL-* / 状态快照）
├─ eslint.config.mjs                # 根 ESLint 9 确定性架构护栏（单向依赖/禁定时器/禁新裸写 useEffect/money 零 IO）
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
| 旧汇率缓存迁移运维 CLI | `services/chat/prisma/rate-cache-migration/` |
| ToB R1 MIG-B 回填/核对运维 CLI | `services/chat/prisma/tob-r1-migration/`（逻辑在 `src/organization/organization-{backfill,reconcile}.ts`，先例同 rate-cache-migration） |
| 新 package       | `packages/<名称>/`，必须含 `README.md`：做什么（职责）、不做什么（边界/非目标）、为何独立成包 |
| 新共享类型       | 后端 DTO 为唯一来源，前端 `bun run generate:api` 从 OpenAPI 生成（禁止手写共享类型） |
| 跨端共享计算逻辑 | `packages/money/`（仅限纯函数：精度、舍入、币种常量；有 IO 的逻辑禁止进包） |
| 接口测试         | `services/chat/test/api/<模块名>.spec.ts`（一个 controller 一个文件；跨租户全矩阵在 `organization-matrix.spec.ts`，409 用例覆盖 16 域 + `2c` 无头拦截 + 列表读隔离 + 组织锁隔离） |
| 集成测试         | `services/chat/test/integration/<模块组合>.spec.ts`（一个业务流一个文件） |
| 单元测试         | 与源码同目录`<被测文件>.spec.ts`                                          |
| E2E 用例         | `e2e/modules/<编号>-<模块>.spec.ts`                                       |
| ToB 组织工作台与 Agent 规划 | `changes/tob-agent-workspace/` |
| ToB R1 后端新模块（组织/成员/邀请/设置、权限策略与 Guard、审计） | `services/chat/src/{organization,authorization,audit}/`，在 `app.module.ts` 唯一注册；`authorization/` 仅纯函数与类型（IO 在 Guard/Service 层） |
| 双域数据请求与双锁守卫 | `services/chat/src/data-request/`：个人域 `/api/data-requests/*`（`DataRequestController`，仅 `JwtAuthGuard`）+ 组织域 `/api/organizations/current/data-requests/*`（`OrganizationDataRequestController`，类级 `@SkipOrganizationLock()`，`JwtAuthGuard → OrganizationContextGuard → OrganizationLockGuard → PermissionGuard`）；`PersonalAccountLockGuard`（全局 `APP_GUARD`，未挂组织锁守卫的路由走个人域单查）/ `OrganizationLockGuard`（**横切守卫，契约与实现分离**：守卫 + `ORGANIZATION_LOCK_RESOLVER` 契约在 `services/chat/src/authorization/guards/organization-lock.guard.ts`，真实判定在 `data-request/organization-lock-resolver.ts`，经全局 `DataRequestModule` 导出后注入——`authorization/` 与 `audit/` 均禁止引入业务记账模块）；双锁白名单装饰器统一在 `services/chat/src/authorization/guards/data-lock.decorators.ts` |
| 组织锁守卫挂载顺序铁律 | `@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)`——先解析 `actor.organizationId`、再检锁、最后检权限；**W30（MIG-D）起组织上下文唯一**：`BusinessOrgScopeGuard`（缺头时猜「唯一默认组织」的兼容窗口守卫）已删除，缺 `X-Organization-Id` 一律 400 `ORGANIZATION_REQUIRED`，不再有单组织回落；放前则无 actor 绕过、放后则 403 先于锁原因返回。**唯一例外**：`PATCH /api/settings` 因按字段分权（`personal` 的 region/locale 放行全部成员 vs `organization` 的 prepPreference/reminderEnabled 需 `settings.update`）未挂类/方法级 `PermissionGuard`，改在 `SettingsService` 持组织锁（`lockOrganizationForActor`）后按字段内联校验角色并写审计（成功同事务 SUCCESS，失败回滚后写 DENIED）——新增按字段分权的端点须照此办理，不得擅自跳过内联校验 |
| 锁查询不变量（每请求至多 1 条 `data_requests` SELECT） | 组织上下文端点由 `OrganizationLockGuard` 发**一条合并查询**（`scope=PERSONAL` 本人注销 ∪ `scope=ORGANIZATION` 当前组织 `CLEAR`/`DELETION`），同时判定两把锁；`PersonalAccountLockGuard` 读到路由 `__guards__` 含 `OrganizationLockGuard` 时直接放行（不再单独查库）；未挂组织锁守卫的路由由个人锁守卫单查个人域。锁判定失败一律 fail-closed（500），白名单端点仅 log warn |
| 双锁错误码 | `ACCOUNT_PENDING_DELETION`（**本人**账号注销处理中，只锁本人）/ `ORGANIZATION_DATA_LOCKED`（**当前组织**账本清空/删除处理中，只锁当前组织）——两者严格区分，互不误判、互不触发对方语义 |
| 组织工作台前端页面 | `clients/chat-web/app/(protected)/organization/`（信息/成员/审计）、`clients/chat-web/app/(protected)/invitations/[token]/` |
| 组织/审计业务组件 | `clients/chat-web/components/business/{organization,audit}/`，带 index.ts 桶文件 |
| 组织上下文前端状态 | `clients/chat-web/lib/stores/organization-store.ts`（仅存 `activeOrganizationId`，严禁持久化 role/capabilities） |
| 组织数据的查询作用域 | 键一律 `withOrgScope(orgId, …)` 且 `enabled: orgId !== null`（`useActiveOrgId()`）；失效走 `invalidateBusinessKey`；受保护区业务区整体包在 `OrganizationScopeBoundary` 内（切组织按 key 重新挂载——`removeQueries` 不通知挂载态的观察者，单靠清缓存页面会冻结在旧组织数据）。账本类 GET（`/settings`、`/reminders`、`/home/*`）另受账本查询闸门约束（见「账本查询闸门」行） |
| 不依赖组织上下文的受保护路由 | `isOrglessRouteAllowed`（`clients/chat-web/lib/hooks/use-organizations.ts`）：路由分流免检、业务区边界传 `bypass` 不重挂载，两处共用同一判定；`/invitations/*` 自己切换组织、重挂载会清掉页面内的结果态；`/data-requests` 承载**个人域**进度，0 组织 / 多组织未选 / 账号注销锁定的用户都必须进得去（403 账号锁的跳转目的地，页内组织分区自行按 `key={orgId ?? "none"}` 重挂载） |
| 组织权限消费（按钮显隐 / 只读态） | `clients/chat-web/lib/hooks/use-organization-capabilities.ts`：`useOrganizationCapabilities()` 实时读后端 `capabilities`，`can(permission)` **fail-closed**（未选组织 / 加载中 / 加载失败 / 键缺失一律 false，权限点键以后端 `permission-policy.ts` 为真源）；**严禁**把 `role` / `capabilities` 写入 localStorage / sessionStorage / organization-store，也严禁按 `role` 在前端推断权限；capabilities 只控制显示，后端始终强制 `@RequiresPermission` |
| 账本查询闸门（查询降噪，§10.3 / DEBT-06） | `useLedgerQueryGate()`（同上文件，纯函数 `resolveLedgerQueryGate`）：未选组织 / 组织详情在途 / 未建账 / 组织删除处理中一律不发账本类 GET；消费方不得各写一份门控——`/settings` 只经 `useOrganizationSettings()`（`lib/hooks/use-organization-settings.ts`）、`/reminders` 经 `useReminders()`、`/home/*` 经 `useHomeState()`。CLEAR 冷静期不拦读（写由后端 403 引导）；组织详情读取失败时闸门放行、由业务端点自身裁决 |
| 设置页两域 | `components/business/settings/preferences-form.tsx`：个人展示偏好（`GET/PATCH /settings/personal`，任何登录用户可改，键 `queryKeys.settings.personal()` 独立词根 + `skipOrganizationScope`）与组织账本设置（`GET/PATCH /settings`，键 `withOrgScope(orgId, settings.detail())`，无 `settings.update` 只读）各自暂存、页面级**单个** `settings-save` 分别提交；草稿是受控初始态（编辑器以服务端值为 key 重新挂载），不写 `useEffect` |
| 数据权利请求前端双域 | `lib/api/data-requests.ts` + `lib/hooks/use-data-request.ts`：个人域（`/data-requests/*`，`skipOrganizationScope` 不带组织头、不依赖 `orgId` 门控、键 `queryKeys.dataRequests.personalCurrent()` 不加前缀）与组织域（`/organizations/current/data-requests/*` + `DELETE /organizations/current`，键经 `withOrgScope` 分桶）端点与 hook 成对命名（`*Personal` / `*Organization`），**禁止混用**；请求体 `scope` 固定为所在域字面量；提交 / 撤回后统一 `invalidateAfterDataRequestMutation`（两域 + 当前组织详情的锁摘要） |
| 双锁 403 的前端处理 | `consumeDataRequestLock`（`lib/api/client.ts`，`apiClient` 与 SSE 封装共用）：两把锁都整页跳**纯** `/data-requests`（禁拼 `?scope=`——E2E 按精确 URL 匹配），且**不清空** `activeOrganizationId`（组织锁只锁当前组织，侧栏仍可切到其他组织）；`isExpectedControlFlowApiError` 完整包含 `ONBOARDING_NOT_COMPLETED` / `ORGANIZATION_DATA_LOCKED` / `ACCOUNT_PENDING_DELETION` / `PERMISSION_DENIED` / `ORGANIZATION_REQUIRED` / `ORGANIZATION_NOT_FOUND`（状态码与错误码须同时匹配） |
| 数据权利 UI 分区 | `components/business/account-data/`：设置页 `AccountDataSection` = 「个人账号与数据」（退出登录 / 导出个人数据 / 注销个人账号）+「当前组织数据」（导出 / 清空 / 删除组织）；进度页 `request-panels.tsx` = 个人分区 + 组织分区（后者以 `key={orgId ?? "none"}` 重挂载，个人进度不随切换丢失）；`RequestProgress` 按视图 `scope` 选端点，组织域撤回 / 下载按钮按能力显隐；既有 testid 保留（`account-data-export` / `account-data-clear` / `account-data-delete` / `settings-logout` / `request-progress*`），新增组织区 testid 以 `organization-` 为前缀 |
| 只读 / 无权限提示 | `components/base/permission-notice.tsx`：`PermissionNotice`（整卡，页面主体依赖该权限时）与 `PermissionHint`（行内，内容可读仅写被锁）；权限判定不在此——调用方先 `can(...)` 再渲染 |
| 受保护页能力门控 | 写按钮显隐一律 `useOrganizationCapabilities().can(...)`：Onboarding / 补录初始持仓 `settings.update`；Plan 新建 `plan.create`，调整 / 完成 / 取消 / 重新开启 `plan.adjust` 且叠加服务端 `canXxx`，记录使用 `usage.create`，录入买入 `transaction.create`；更正入口与提交 `correction.apply`，更正页预演 `correction.preview`；组织数据 导出 `data.export`、清空 `data.clear && onboardingCompleted`、删除 `organization.delete`。组织详情未返回前不渲染写按钮（防权限闪烁） |
| 退出登录出口 | `useLogoutAndRedirect()`（`lib/query/hooks/use-auth.ts`）：侧栏、设置页、`OrganizationPicker`、`OrganizationRoutingError` 共用（后两者整屏渲染没有侧栏）；页面不得各自拼接「登出 + 清用户态 + 跳转」 |
| 切换组织类回调里的后续动作 | hook 级回调同步改组织选择会让布局卸载调用方组件，`mutate(…, { onSuccess })` 的调用点回调不再派发——导航等后续动作用 `mutateAsync().then(…)` 或写进 hook 级回调，不依赖挂载态 |
| 外部中止当前流 | 一律调 `abortActiveStream()`（`clients/chat-web/lib/stores/chat-store.ts`，同时重置聊天运行时态）；`use-chat` 收尾以句柄归属决定是否清理，只中止不重置会永久锁死输入框 |
| 默认组织（个人工作台）判定 | `services/chat/src/authorization/default-organization.ts`：用户创建的最早组织；建组织必须嵌套写入（组织与首位成员同事务创建）；回填 / 核对 SQL 的 `defaults` CTE 与之同口径 |
| 持锁写的操作者资格 | 组织锁内一律经 `lockOrganizationForActor` 重读操作者并以最新角色判定，不得沿用 Guard 放行时的 `actor.role`（等待锁期间可能已被降权 / 移除 / 失去所有权） |
| 会话上下文重置 | `clients/chat-web/lib/auth/session-reset.ts`：登录 / 注册 / 登出 / 401 的唯一入口；业务代码不单独清组织选择、拒绝集合或聊天运行时态 |
| 组织 E2E 用例 | `e2e/modules/15-organization.spec.ts`（Goal #3A W21 + Goal #3C W31 全量 32 用例覆盖 R1 GWT-1..18 与 GWT-26..30，人类启服后运行）；`e2e/helpers/org-scope.ts` 负责造数端按路径自动注 `X-Organization-Id` |
| 建账后的缓存失效 | `invalidateAfterOnboarding`（`lib/api/query-keys.ts`）必须连带失效 `queryKeys.organizations.all`；向导页 / 补录页导航前须 `await refreshOrganizationDetails(queryClient)`（同文件）——首页分流读组织详情缓存的 `onboardingCompleted`（键不带 org 前缀，`invalidateBusinessKey` 覆盖不到），漏掉即建账后在 `/home` ↔ `/onboarding` 间回弹；回读失败时该函数移除组织域查询再放行，不带着旧的「未建账」详情导航 |
| E2E Node 侧直连后端 | 一律 `localFetch(buildApiUrl(回环地址, …))`（`e2e/helpers/api-url.ts`），回环地址 = `API_URL.replace("localhost", "127.0.0.1")`；禁止取 LAN IP / `os.networkInterfaces()`（TUN 下命中 utun）；按 IP 频控由 `run-e2e-tests.sh` 的 `OTP_IP_MAX_REQUESTS` 放大 |
| E2E 组织管理端点造数 | `api(path, { headers: { "X-Organization-Id": orgId } })`（`e2e/helpers/api-seeder.ts`）——`/organizations/current/*` 的成员 / 邀请 / 所有权端点挂严格守卫，缺头 400；所有权转交 = `POST /api/organizations/current/transfer-ownership` |
| E2E 本地测试库钩子 | 均在**同一函数内**校验回环 PostgreSQL 并拒绝 `?host=` 覆盖，再经 `createRequire` 用后端 Prisma 客户端：`correction-db.ts`（W30 MIG-F 后记账起点只存 `OrganizationSettings`，`UserSettings` 已无该列）、`correction-quote-db.ts`、`organization-db.ts`（组织邀请过期辅助，同含回环+非 `?host=`+`assertRateCacheTestDatabase` 闸门）、`rate-cache-db.ts`（外呼取价 `RATE_UNAVAILABLE` 时插入已确认 frankfurter 缓存行，`latestConfirmedAt=now` + `canonicalWriteId`，重试后立即按 id 清理；并导出库名闸门 `assertRateCacheTestDatabase`——会写 `exchange_rates` 的钩子共用：显式 `FXPLANNER_E2E_QUOTE_DATABASE` 须等于库名，未注入时库名以 `_local` / `_test` 结尾才放行，脚本从 `services/chat/.env.local` 解析库名注入）；直插账本行须落 `organizationId`（W30 MIG-E 起该列 **NOT NULL**，不得再回落兼容窗口 NULL 行） |
| MVP-F0 汇率回补与缓存迁移底稿 | `changes/realtime-rate/` |
| 汇率缓存迁移完成记录与行归属 DDL | `services/chat/prisma/migrations/20261120090000_rate_cache_migration_receipt/` |
| 汇率回源方向标记 DDL | `services/chat/prisma/migrations/20261120091000_rate_cache_canonical_write/` |
| 验证与防回归规范 | `docs/VERIFY.md`（验证分级、属性/差分测试、Diff 触发检查）、`docs/FEATURE-MAP.md`（用户视角功能地图） |
| 确定性静态护栏 | `eslint.config.mjs`（架构边界/禁定时器/禁新裸写 useEffect/money 零 IO）、`scripts/check-structure.ts`（目录与契约头守卫）、`scripts/check-org-scope.ts`（`check:org-scope`：12 业务模块 `ts-morph` 租户隔离静态守卫） |
| 前端 / 服务端脱敏规则对照 | `clients/chat-web/lib/dev-log/mask.ts` 与 `packages/dev-log-server/src/mask.ts` 的邀请规则手工同步；`scripts/__tests__/mask-parity.spec.ts` 用同一组向量跑两份实现，改一处必须让对照用例通过 |
| 迭代路线与工作流手册 | `docs/ITERATION-REFACTOR-ROADMAP-20261119.md`、`docs/VIBE-CODING-PLAYBOOK.md` |
| 跨会话交接文档   | `docs/handoff/`（夜间批次产出：OVERNIGHT-* / 接力目标提示词：GOAL-* / 状态快照；需求/方案/验收仍归 `changes/`） |

### 组件引用

单向依赖：`business → base → ui`，禁止反向。

### 测试约定

- **三类防愚弄测试（Anti-Gaming Tests）**：
  - **E2E + 行为断言量表**：前端只测 `lib/hooks`，组件与业务流防线是 Playwright E2E；对照 `docs/VERIFY.md` 与 `docs/handoff/` 行为断言清单打分，拒绝只测 mock 的同义反复（tautological）测试。
  - **属性测试（Property-based Testing，`fast-check`）**：`packages/money/`（币种常量、金额/汇率换算、舍入规则纯函数）及核心 DTO 校验逻辑新增或修改时，**必须编写属性测试**，验证往返守恒（Round-trip）、精度/非负/守恒不变量（Invariants）、重复计算幂等性（Idempotency）与等价性（Equivalence）。
  - **差分测试（Differential Testing）**：从旧版 `FXplanner` 迁移换汇计算、计划生成或更正流水逻辑时，以旧版输出或黄金样本集为 Oracle 同输入比对，归一化无关噪音并记录合法差异白名单。
- **廉价检查先行 & 本地 3 轮自愈熔断**：先跑本地 `bun run typecheck` / `bun run lint` / `bun run test unit api integration infra web scripts money dev-log`，通过后再跑 E2E；同一测试/构建失败本地自动修复最多 **3 轮**，连续 3 轮未果必须立即停机汇报人类，严禁死循环盲改。
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
