# Goal #3A 验收交接报告 — ToB R1 Part A：组织地基、只读隔离与成员/审计闭环（2026-11-23）

> 分支：`feat/tob-r1-a-foundation-read-members`（基于 `dev` `37b5900` 切出）
> 治理提示词：`docs/handoff/GOAL-3A-TOB-R1-FOUNDATION-READ-MEMBERS-20261123.md`
> 上游：PR #9（Goal #2）已合入；T-AI-003 按 `docs/handoff/T-AI-003-WAIVER-20261123.md` 书面豁免

---

## 1. 提交清单（W13–W21 垂直切片）

| 切片 | Commit | 说明 | 验证戳记 |
| --- | --- | --- | --- |
| W13（AUTH-01） | `4d5353c` | 目录契约 + ESLint 后端模块单向依赖护栏 + 纯函数 RBAC 策略（5 角色 × 28 权限点完整矩阵） | unit, diff |
| W14（MIG-A） | `12d2638` | 6 新表 + 11 业务表可空组织列增量迁移 + 单活跃 Owner 部分唯一索引；空壳兼容锁定（既有测试零回归）；附带 rate W8 计划断言的规划器统计确定性加固 | infra, api, integration |
| W15（MIG-B） | `dc8b2ee` | 幂等默认组织回填 + §12.3 一致性核对 CLI（tob-r1-migration，双旗标写保护）；organization-migration 集成测试（幂等/孤儿阻断/跨组织差异检出） | unit, integration, diff |
| W16（AUDIT） | `91655f1` | AuditModule（同事务 writer + 脱敏 sanitizer + 只读分页）+ organization-scope 纯函数 | unit |
| W17（ORG-00..02） | `70e5468` | OrganizationContextGuard/PermissionGuard + 组织 CRUD/审计 API（capabilities 后端真源；404 不泄露存在性） | unit, api, integration |
| W18（LEDGER-01 读侧） | `978b676` | BusinessOrgScopeGuard（兼容窗口唯一默认组织回落）+ 10 模块全部业务 GET 组织隔离 + 注册兜底建组 + organization-read-isolation 集成测试 | unit, api, integration, diff |
| W19（MEM-01/02） | `8ecb1f0` | 邀请状态机（SHA-256 token、7 天期、幂等复用、并发接受单 Membership）+ 成员生命周期（先降后升所有权转移、最后 Owner 409）+ OpenAPI 双跑幂等 | unit, api, integration, diff |
| W20（前端底座） | `d5bb4a7` | organization-store（仅存选择）+ X-Organization-Id 传输 + 组织作用域 Query Key/切换缓存清理 + 6 数据 hooks 绑定 | unit, diff |
| W21（前端工作台） | `56a1e86` | 组织切换器/选择器、成员/邀请/审计页、受邀接受页、(protected)/layout 组织路由分流 + E2E 骨架 T-ORG-001..007 | unit, diff |

**改动规模**：`git diff dev...HEAD` — 129 文件（clients 43 / services 84 / e2e 1 / 根配置 2）。

## 2. MIG-A/MIG-B 备份库演练证据（W15 Checkpoint）

- **库**：`fxplanner_new_db_migbak`（由 `~/pgdata/backups/fxplanner_new_db_local-20261123.dump` 恢复；恢复流程见 `docs/handoff/PRE-GOAL3A-CLOSURE-20261123.md` §6）。
- **流程**：MIG-A `migrate deploy` → `backfill`（dry-run 估算 389 组织、243/315/43/358/282/125/36/15/25/123 行）→ `backfill --apply --confirm-backup-target` → `verify` → **二次 apply（幂等）** → `verify`。
- **结果**：两次 `verify` 均 **3760 项检查、0 diffs（exit 0）**；二次 apply `organizationsCreated=0 / usersSkippedIdempotent=389`（幂等实证）。
- **集成测试**（`test/integration/organization-migration.spec.ts`，6/6 绿）：完整存量账本用户 + 无设置用户全量映射与语义映射断言；§12.3 核对 0 差异；孤儿 usage/planAllocation 行预检阻断零写入；跨组织异常行核对显式报差异并恢复基线。

## 3. 关键验证矩阵（§4）

| 级别 | 检查项 | 结果 |
| --- | --- | --- |
| §4.1 | `git diff dev...HEAD` 对照 `docs/VERIFY.md` §2（Prisma DDL/回填、Guard/RBAC、OpenAPI、前端 hooks 全命中） | ✅ |
| §4.1 | `generate:api` 重跑零 git diff（openapi.json `07fa0bea…` / schema.gen.ts `5ff251c9…` 双跑一致） | ✅ |
| L1 | `check:structure` / `lint` / `typecheck` | ✅ 全过 |
| L1 | `unit web scripts money dev-log` | ✅ 0 failed |
| L2 | `db:status`（PostgreSQL 5432 在线） | ✅ |
| L2 | `api integration infra`（含 organization/membership/audit/read-isolation/migration 新套件与全量既有回归） | ✅ 0 failed |
| L2 | `build`（Node 24；Next.js 全新路由含 organization×3、invitations/[token] 构建通过） | ✅ |
| L3 | 探活 / Playwright | **NOT_RUN**（AGENTS.md AI 禁启服务；清单见 §5） |
| §4.5 | 独立对抗审（D6） | 见 §4 |

### 隔离与权限测试要点（W17/W18/W19 套件）

- **跨组织 404 不漏存在性**：双组织成员带 B 头请求 A 组织记录（Account/Plan/Transaction/Correction/Report/AiConversation/usage/corrections 列表）全部 404（`organization-read-isolation.spec.ts` #2）。
- **同组织一致视图**：Viewer 与 Owner 在 Org A 读取完全一致的账户/计划/交易/使用/更正/报告/首页（#1）。
- **多组织缺头 400**：7 个业务 GET 端点无头请求 400 ORGANIZATION_REQUIRED（#3）；单组织无头回落默认组织（#5）。
- **降权秒级生效**：DB 降 VIEWER / DISABLED 后同旧 JWT 立即 403/404（organization.spec / read-isolation #4）。
- **所有权转移**：先降后升顺序、单活跃 Owner 不变量复验、原 Owner 反向转移 403（membership.spec）。
- **并发接受**：双请求 Promise.allSettled 恰一方 200、Membership 计数=1（membership.spec）。
- **token 纪律**：库内仅 SHA-256 hash；列表/审计/日志序列化不含 token 原文（membership.spec 断言 JSON.stringify 全文）。

## 4. 独立对抗审（D6）

- **执行方式**：Codex CLI 在本机不可用（Goal #2 会话已验证 `model_not_found`），按 GOAL-3A §4.5 降级为独立只读 Explore 子代理，以 `git diff dev...HEAD` 增量为审查对象（R1 审查覆盖六个围堵面 + R2 增量复核）。
- **R1 结果**：`Verdict: 1 [Important], 6 [Nit], 0 [Pre-existing]`。
  1. `[Important]` `clearOrganizationScopedQueries` 遗漏 members/invitations/auditLogs 无前缀键——切组织时组织工作台页（路由不卸载）残留旧组织成员/邀请/审计列表（写操作有后端 404 挡、无越权，但属需求 15.1.4 必须修复的跨组织脏展示）→ **已修复**：三键加入清理列表 + `switchOrganization` 显式 invalidate 兜底 + 键形态注释修正。
  2. `[Nit]` 数组头静默取首元素与文档「严格拒绝」不一致 → **已修复**（两 Guard `Array.isArray` 即 400）。
  3. `[Nit]` 并发所有权转移唯一索引违规冒 500 → **已修复**（P2002 映射 409 TRANSFER_CONFLICT）。
  4. `[Nit]` 受邀页裸拼 queryKey 违反工厂自律 → **已修复**（`queryKeys.organizationInvitation.summary(token)`）。
  5. `[Nit]`（未修、记 backlog）`organizations.current` 键不含组织 id，切换后 capabilities 有短暂旧值窗（后端强制校验兜底，仅按钮显隐瞬时错位）——**已在外部评审修复轮解决**：详情键按组织 id 分桶（§8，`268ac2a`）。
  6. `[Nit]`（未修、记 backlog）PermissionGuard 拒绝前 await DENIED 审计，审计库挂起会推迟 403（try/catch 不吞错；可加超时）。
  7. `[Nit]`（未修、记 backlog）layout 单组织自动选中分支依赖后续请求兜底清缓存——**已在外部评审修复轮解决**：选择校正迁入受控 hook `useOrganizationRouting`，不在渲染期写 store（§8，`268ac2a` / `601df0b`）。
- **R2 增量复核（修复提交后）**：`Verdict: 0 [Important], 3 [Nit], 0 [Pre-existing]`——**[Important] 清零**。四项修复全部 [PASS]（清理列表前缀匹配覆盖实际键形态、数组头无回归、P2002 映射精确不误吞、工厂键引用完整）。残余 3 个 [Nit]：
  1. `organizations.current` 键不含组织 id（R1 已记 backlog）——**外部评审修复轮已解决**（§8）；
  2. transfer 端点 `@ApiConflictResponse` 未列 TRANSFER_CONFLICT、并发 409 映射无专测——**本次收尾已补**（注解 + membership.spec 并发双提交用例）；
  3. DENIED 审计 await 推迟 403（R1 已记 backlog；**仍未修**，随 Goal #3B 一并评估）。

## 5. L3 人工 E2E 跑测清单（NOT_RUN 项）

1. `e2e/modules/15-organization.spec.ts`（**外部评审修复轮已重写**，T-ORG-001..010：单组织直达/侧栏组织入口/邀请真实邮箱/受邀接受并进入该组织/角色调整/审计只读/Viewer 选择页与权限边界/成员退出/新建组织与切换/登出清除组织选择）——用例已通过独立类型检查，**未运行**；首次运行请按实际渲染校准定位器；
2. 既有全量 `e2e/modules/`（01–14，含 T-AI-003 豁免单在案：预期「仅 T-AI-003 显式失败」）；其中受本轮前端改动影响的回归点：写操作后首页/计划列表即时刷新、切换组织后 AI 流被中止、导出下载携带组织头、登出后换账号不继承组织；
3. 运行手册：`FXPLANNER_E2E_QUOTE_DATABASE=fxplanner_new_db_local ./e2e/scripts/run-e2e-tests.sh --headless`（见 PRE-GOAL3A-CLOSURE §5）；跑完 `rm -rf e2e/test-results`。

## 6. Goal #3B 启动准入核对（W18 兼容窗口遗留清单）

以下路径在 Goal #3B（业务写 Actor 化 + DataRequest 拆分）收口，本批有意保留（外部评审修复轮后的现状，详见 §8.4）：

1. **写路径 userId 语义**：业务写接口（POST/PATCH/DELETE account/plan/transaction/usage/correction/onboarding/settings）仍按 userId 写入（organizationId 落 NULL，兼容窗口由读侧 `compatReadWhere` NULL 分支可见）；Goal #3B 切 ActorContext 写 + `compatReadWhere` 移除。读侧 NULL 分支**已锚定默认组织**（只在默认组织上下文可见，不再渗入后来新建/加入的组织）。
2. **注册兜底**：`auth.service.register` 与验证码首登均建默认组织（同事务）；**onboarding complete 建 OrganizationSettings 的组织化**未做——多组织用户无法为第二个组织走 `onboarding/complete` 建账（写路径仍按 userId，已建账用户会 409），随 Goal #3B。
3. **reminder**：读侧列表与生成已在**当前组织作用域**内（`compatReadWhere`）；`markRead` / `readAll` 仍写行内 `Reminder.readAt`（行主语义），成员级 `ReminderRead` 写路径随 Goal #3B W25。
4. **AI 会话**：读路径的 `organizationId IS NULL` 兼容分支**有意未锚定**默认组织——建会话/追问/删除的写路径尚未接入组织作用域，只锚定读侧会让非默认组织里新建的会话不可见。W25 之前 AI 会话是**个人级**资源（仅本人可见，不按组织分区），见 `services/chat/src/ai/ai.service.ts` 注释。
5. **DataRequest**：scope 列已迁移（PERSONAL 默认、历史 CLEAR 由 MIG-B 映射 ORGANIZATION），但**请求创建/锁逻辑未拆**（个人/组织两类锁 = Goal #3B W22-W24 范围）。
6. **账号注销与组织**：DELETION 物理删除用户时 Membership 随之级联而组织不级联——用户独占的组织会留下无主空壳（组织 + 设置 + 审计 + 邀请），若其为某组织最后 Owner 则该组织失去所有者。「最后 Owner 保护 / 注销前组织处置」属 Goal #3B W26，本轮未改后端行为。
7. **前端兼容**：未选组织时业务请求不带组织头（后端唯一默认组织回落）；Goal #3B 切写后前端全量带头并关闭回落（BusinessOrgScopeGuard 收敛为严格 400）。

## 7. 交接人下一步

- [ ] 人工启服跑 §5 E2E 清单（15-organization 已重写为 T-ORG-001..010，首次运行校准定位器）
- [ ] 对照评审原文核对 §8.2 的条目标题，特别是 N-05 / N-08 与 I-21
- [ ] 决定是否执行 §8.5 的本地库孤儿组织清理（不可逆，可选）
- [ ] 对抗审意见（§4 回填后）[Important] 项清零确认
- [ ] Draft PR 评审后转 Ready、合入 `dev`，随后以 `docs/handoff/GOAL-3B-TOB-R1-LEDGER-WRITE-DATA-SPLIT-20261123.md` 启动 Goal #3B

## 8. 外部评审修复轮（2026-11-23）

> 输入：外部评审文档（21 `[Important]` / 11 `[Nit]` / 2 `[Pre-existing]`，分 A RBAC / B 并发 / C 隔离 / D 审计·迁移·契约 / E 前端·E2E）。
> 处置原则：逐条对照代码核实后采纳；不采纳或延期的写明理由。条目标题以评审原文为准。

### 8.1 提交清单

| Commit | 范围 | 验证戳记 |
| --- | --- | --- |
| `7c6003f` | A 组 RBAC（I-01~I-05）、B 组并发（I-06/I-07）、I-09、I-12、I-13、契约（I-17）、N-01/02/03/04/06/07/10 | unit, api, integration, infra, web, diff |
| `356f141` | C 组隔离：I-08、I-10、I-11 | unit, api, integration |
| `eab0a00` | D 组审计：I-14 | unit |
| `989bbbb` | D 组迁移：I-15、I-16 + N-09、N-11（含新索引迁移 `20261123180000_tob_r1_review_followup_indexes`） | unit, integration, infra, diff |
| `268ac2a` | E 组前端：I-18、I-19、I-20（含重生成的 openapi.json / schema.gen.ts） | unit |
| `601df0b` | 修复轮自查发现的竞态：应用设置的组织选择被过早清除 | unit |
| `a920319` | E 组 E2E：`15-organization.spec.ts` 重写（T-ORG-001..010） | none（E2E 需人类启服） |
| `27cd653` | 测试卫生：两个集成用例不再泄漏孤儿组织 | integration |

### 8.2 逐项评估

**[Important]（21 项）**

| 编号 | 问题 | 评估 | 处置 |
| --- | --- | --- | --- |
| I-01 | `updateRole` 只校验目标角色，Admin 可把 Viewer 提为 Admin | 成立 | 采纳：`canManage` 双侧校验 |
| I-02 | 接受邀请覆盖既有 ACTIVE 成员关系；可邀请已是成员的邮箱 | 成立（可借 VIEWER 邀请把唯一 OWNER 降级，组织失去所有者） | 采纳：409 `MEMBER_ALREADY_ACTIVE`；accept 拒绝覆盖并回滚 |
| I-03 | `revoke` 资格写死 VIEWER | 成立 | 采纳：按邀请自身角色判定 |
| I-04 | `LAST_OWNER_REQUIRED` 分支不可达 | 成立 | 采纳：Owner 自降/自移 409，Admin 对 Owner 仍 403 |
| I-05 | 邀请摘要端点不校验登录身份（持链接即得组织名与邀请人） | 成立 | 采纳：三个 token 端点均先匹配登录身份 |
| I-06 / I-07 | 成员/邀请变更存在读后写竞态 | 成立 | 采纳：组织级 advisory lock + 条件更新；并发用例确定性断言 |
| I-08 | 兼容分支 `{ organizationId: null, userId }` 无条件生效，个人数据渗入后来新建/加入的组织 | 成立 | 采纳：`compatReadWhere` 锚定默认组织。**例外**：AI 会话读路径有意不锚定（见 §6.4，W25） |
| I-09 | 验证码注册首登不建默认组织，业务 GET 全部 400，无法接受邀请 | 成立 | 采纳：同事务 bootstrap |
| I-10 | 受邀成员没有个人设置行，读设置 409 | 成立 | 采纳：组织偏好解析（组织设置优先，仅默认组织回落所有者个人设置） |
| I-11 | 提醒列表用行内 `readAt` 过滤，行主读过即对他人消失 | 成立 | 采纳：读侧候选集与成员级已读态 |
| I-12 | 三个只读预览端点未挂守卫与 RBAC | 成立 | **部分采纳**：守卫链与权限已加；内部查询保持 userId（预览与执行共用一条 `evaluate()` 管线，须随写路径 Actor 化一并迁移 → Goal #3B） |
| I-13 | 未知角色值被 `as OrganizationRole` 放过；未认证与数组头处理不一致 | 成立 | 采纳：未知角色 403、未认证 401、数组头 400、无头回落单次查询 |
| I-14 | 审计脱敏是全等表，`accessToken` / `password_hash` 等真实字段名全部漏网；Date 被抹成 `{}`、BigInt 使 detail 不可序列化 | 成立 | 采纳：按词匹配 + 短语 + JSON 语义序列化 |
| I-15 | MIG-B 回填改写 `updated_at`；重跑会把 R1 之后的组织级数据请求改写到默认组织；dry-run 把 `userId` 当 `plan_change_logs` 的列；全库单事务会超时；默认组织解析无排序；CLI 生产库名匹配大小写敏感 | 成立 | 采纳：原生 UPDATE 只写租户列、仅映射未挂组织的存量行、dry-run 与写入同条件、分片事务、`orderBy`、`/fxplanner_prod/i` + `NODE_ENV` |
| I-16 | §12.3 核对逐用户约 20 条查询，漏检 `initial_holdings` / `reminders` / `ai_conversations` / `plan_change_logs` | 成立 | 采纳：6 条静态语句 26 项检查（行集恒等 + 不变量专项），全静态 SQL + 绑定参数 |
| I-17 | 前端手写影子类型；新控制器缺 `@ApiBody` 等导致请求 DTO 生成为 `never` | 成立 | 采纳：全部取 `schema.gen` 别名，OpenAPI 重生成 |
| I-18 | 组织选择生命周期：登出/401 不清选择、layout 渲染期写 store、旧组织迟到响应清新选择、被移出后「清除 → 自动选回」循环、硬跳转丢页面、SSE 与下载不带组织头、铃铛把人从邀请页带走 | 成立 | 采纳：见 `268ac2a` / `601df0b` |
| I-19 | 带组织前缀的缓存键 `["org", id, …]` 不会被 `invalidateQueries({ queryKey: ["plans"] })` 命中 | 成立，且是功能性缺陷：写操作后首页状态、计划列表、会话列表不刷新 | 采纳：`invalidateBusinessKey` 同时命中无前缀与任意组织前缀形态 |
| I-20 | 切换组织不中止 SSE、不重置聊天态；缺导航/新建/退出入口；面包屑暴露邀请 token；日志未脱敏邀请链接；表单未按组织重置；审计入口未按权限门控 | 成立 | 采纳：见 `268ac2a` |
| I-21 | E2E 骨架按原样无法通过（`injectLoginCookie` 传参、邀请邮箱、T-ORG-007 未选组织、`test.skip`） | 成立 | 采纳：重写为 T-ORG-001..010；**未运行**（AI 禁启服务） |

**[Nit]（11 项）**

| 编号 | 处置 |
| --- | --- |
| N-01 / N-02 / N-03 / N-04 / N-06 / N-07 / N-10 | 已采纳（`7c6003f`） |
| N-09 | 已采纳（`989bbbb`）：`reminder_reads(user_id)`、`ai_conversations(organization_id, last_message_at DESC)`；迁移测试夹具批次守恒修正 |
| N-11 | 已采纳（`989bbbb`）：`ReminderRead` 唯一性测试，另补索引落库断言 |
| N-05 / N-08 | 本轮工作记录中**没有留下处置结论**，交接时请对照评审原文确认 |

**[Pre-existing]（2 项）**：按约定记入 backlog，不阻断本轮；标题以评审原文为准。

### 8.3 验证证据

- **后端全量**：unit 612（42 文件，另 1 todo）/ api 363（21）/ integration 104（16）/ infra 18 —— 0 failed。
- **前端**：vitest 294（30 文件；修复前基线 258 / 28）—— 0 failed。新增/改写的断言是行为级的（真实 QueryClient 中同时放置无前缀与带前缀两份数据、断言两者都被失效），不再断言 `invalidateQueries` 的调用形状。
- **仓库级**：根 `lint`（ESLint + 结构守卫 + 两包 lint-observe 门禁）、`typecheck`（4 任务）、`build`（Next + Nest）全部通过；`generate:api` 重跑零 git diff（相对修复前仅有意的两处描述变化 + 控制器扫描顺序导致的路径重排，61 条路径 / 142 个 schema 无增减）。
- **MIG-B 真实数据演练**（临时库，由校验过的 dump 恢复，跑完已删除）：`migrate deploy` 后 `migrate diff` 为空 → 回填前 `verify` 恰 2 处差异（389 用户缺默认组织、4 条已读提醒缺成员级已读行）→ dry-run 估算与实际写入逐项一致 → `verify` 26 项 0 diffs → 重跑全 0（幂等）→ 仍 0 diffs。**17 张表「整行剔除租户列」的 MD5 指纹回填前后完全不变**。与旧实现对同一份 dump 的输出做差分：14 项租户列指纹完全一致，唯一差异是 `updated_at` 被改写的行数 266 → 0。
- **测试泄漏实测**：修复前每次全量跑本地库新增 9 条无成员组织；修复后跑两个用例，孤儿数 2156 → 2156。
- **E2E**：`15-organization.spec.ts` 通过独立类型检查，**NOT_RUN**。

### 8.4 有意不做 / 已知限制

1. **AI 会话不按组织分区**（W25 之前）：见 §6.4。
2. **预览端点内部查询仍按 userId**：见 I-12。
3. **页面/组件级查询键未系统性地加组织前缀**：目前只有 4 个 hook 带前缀；其余靠切换时显式清理无前缀键。系统性改造随 Goal #3B（届时写路径带头后再做）。
4. **`verify` 是迁移时点闸门**：须在停写窗口内执行；上线后业务数据可在非默认组织演进，不作常驻巡检。
5. **`fxplanner_new_db_migbak` 仍是旧实现的回填结果**（`updated_at` 已被改写），本轮被用作差分 Oracle 未改动；W30 演练前建议按 PRE-GOAL3A-CLOSURE §6 重建。
6. **账号注销留下无主组织**：见 §6.6。

### 8.5 待人类决定

1. **本地库历史孤儿组织**（`fxplanner_new_db_local`，2156 条，全部为历史测试残留，无业务行引用；泄漏已止住）。清理不可逆，AI 未执行。确认后可运行：

   ```sql
   -- 先核对数量（两条应相等）
   SELECT count(*) FROM organizations o
    WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = o.id);
   -- 再删除（审计日志对组织无外键，须先删）
   BEGIN;
   DELETE FROM audit_logs a
    WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = a.organization_id);
   DELETE FROM organizations o
    WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = o.id);
   COMMIT;
   ```

2. **本地库已应用新索引迁移** `20261123180000_tob_r1_review_followup_indexes`；其他开发机与 CI 环境需 `prisma migrate deploy`。
3. **E2E 运行**与定位器校准（§5）。
4. **N-05 / N-08 与 I-21 的条目标题**请对照评审原文确认。
