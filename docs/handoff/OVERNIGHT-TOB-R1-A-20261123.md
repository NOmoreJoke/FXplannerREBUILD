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

**改动规模**：`git diff dev...HEAD` — 192 文件（11-24 终验提交后；`a96ecda` 时点为 158 文件，含 §8 外部评审修复轮；本表 W13–W21 提交时点为 129 文件）。§9–§10 的评审修复轮改动已提交，清单见 §10.5 第 4 项。

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
| L3 | 探活 / Playwright | `15-organization.spec.ts` 11/11 通过（11-24，§10.4）；§5 清单其余项未跑 |
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

1. `e2e/modules/15-organization.spec.ts`（**外部评审修复轮已重写**，T-ORG-001..010 含 007B 共 11 条：单组织直达/侧栏组织入口/邀请真实邮箱/受邀接受并进入该组织/角色调整/审计只读/Viewer 选择页与权限边界/切换组织后页面数据刷新/成员退出/新建组织与切换/登出清除组织选择）——用例已通过独立类型检查，**未运行**；首次运行请按实际渲染校准定位器；
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

- [x] 人工启服跑 §5 E2E 清单：`15-organization.spec.ts`（T-ORG-001..007B..010 共 11 条）11-24 跑通 11/11（§10.4）；清单其余项未跑
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
| `0cbb63f` | 修复轮自查：被服务端拒绝的组织在同一会话内重新加入后可再次进入 | unit |

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
| I-12 | 三个只读预览端点未挂守卫与 RBAC | 成立 | **部分采纳**：守卫链与权限已加；内部查询保持 userId（预览与执行共用一条 `evaluate()` 管线，须随写路径 Actor 化一并迁移 → Goal #3B）。**R2 轮已补齐读侧**（§9 R2-I02）：三个预览按组织作用域读取，写路径仍随 Goal #3B |
| I-13 | 未知角色值被 `as OrganizationRole` 放过；未认证与数组头处理不一致 | 成立 | 采纳：未知角色 403、未认证 401、数组头 400、无头回落单次查询 |
| I-14 | 审计脱敏是全等表，`accessToken` / `password_hash` 等真实字段名全部漏网；Date 被抹成 `{}`、BigInt 使 detail 不可序列化 | 成立 | 采纳：按词匹配 + 短语 + JSON 语义序列化 |
| I-15 | MIG-B 回填改写 `updated_at`；重跑会把 R1 之后的组织级数据请求改写到默认组织；dry-run 把 `userId` 当 `plan_change_logs` 的列；全库单事务会超时；默认组织解析无排序；CLI 生产库名匹配大小写敏感 | 成立 | 采纳：原生 UPDATE 只写租户列、仅映射未挂组织的存量行、dry-run 与写入同条件、分片事务、`orderBy`、`/fxplanner_prod/i` + `NODE_ENV` |
| I-16 | §12.3 核对逐用户约 20 条查询，漏检 `initial_holdings` / `reminders` / `ai_conversations` / `plan_change_logs` | 成立 | 采纳：6 条静态语句 26 项检查（行集恒等 + 不变量专项），全静态 SQL + 绑定参数 |
| I-17 | 前端手写影子类型；新控制器缺 `@ApiBody` 等导致请求 DTO 生成为 `never` | 成立 | 采纳：全部取 `schema.gen` 别名，OpenAPI 重生成 |
| I-18 | 组织选择生命周期：登出/401 不清选择、layout 渲染期写 store、旧组织迟到响应清新选择、被移出后「清除 → 自动选回」循环、硬跳转丢页面、SSE 与下载不带组织头、铃铛把人从邀请页带走 | 成立 | 采纳：见 `268ac2a` / `601df0b`。**R2 轮补齐残余**（§9 R2-I09 / R2-I10）：流收尾的句柄归属、登录/注册/登出/401 统一会话重置、单组织首帧门控 |
| I-19 | 带组织前缀的缓存键 `["org", id, …]` 不会被 `invalidateQueries({ queryKey: ["plans"] })` 命中 | 成立，且是功能性缺陷：写操作后首页状态、计划列表、会话列表不刷新 | 采纳：`invalidateBusinessKey` 同时命中无前缀与任意组织前缀形态。**R2 轮补齐残余**（§9 R2-I07 / R2-I08）：切换组织时挂载态页面冻结在旧组织数据、审计页跨组织串显 |
| I-20 | 切换组织不中止 SSE、不重置聊天态；缺导航/新建/退出入口；面包屑暴露邀请 token；日志未脱敏邀请链接；表单未按组织重置；审计入口未按权限门控 | 成立 | 采纳：见 `268ac2a`。**R2 轮补齐残余**（§9 R2-I11 / R2-I12）：建账完成后丢失邀请回跳、邀请 token 仍经 dev-log 明文落盘 |
| I-21 | E2E 骨架按原样无法通过（`injectLoginCookie` 传参、邀请邮箱、T-ORG-007 未选组织、`test.skip`） | 成立 | 采纳：重写为 T-ORG-001..010；**未运行**（AI 禁启服务）。**R2 轮修正必挂与竞态**（§9 R2-I13）：新增 T-ORG-007B，仍未运行 |

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
- **前端**：vitest 295（30 文件；修复前基线 258 / 28）—— 0 failed。新增/改写的断言是行为级的（真实 QueryClient 中同时放置无前缀与带前缀两份数据、断言两者都被失效），不再断言 `invalidateQueries` 的调用形状。
- **仓库级**：根 `lint`（ESLint + 结构守卫 + 两包 lint-observe 门禁）、`typecheck`（4 任务）、`build`（Next + Nest）全部通过；`generate:api` 重跑零 git diff（相对修复前仅有意的两处描述变化 + 控制器扫描顺序导致的路径重排，61 条路径 / 142 个 schema 无增减）。
- **MIG-B 真实数据演练**（临时库，由校验过的 dump 恢复，跑完已删除）：`migrate deploy` 后 `migrate diff` 为空 → 回填前 `verify` 恰 2 处差异（389 用户缺默认组织、4 条已读提醒缺成员级已读行）→ dry-run 估算与实际写入逐项一致 → `verify` 26 项 0 diffs → 重跑全 0（幂等）→ 仍 0 diffs。**17 张表「整行剔除租户列」的 MD5 指纹回填前后完全不变**。与旧实现对同一份 dump 的输出做差分：14 项租户列指纹完全一致，唯一差异是 `updated_at` 被改写的行数 266 → 0。
- **测试泄漏实测**：修复前每次全量跑本地库新增 9 条无成员组织；修复后跑两个用例，孤儿数 2156 → 2156。
- **E2E**：`15-organization.spec.ts` 通过独立类型检查，**NOT_RUN**。

### 8.4 有意不做 / 已知限制

1. **AI 会话不按组织分区**（W25 之前）：见 §6.4。
2. **预览端点内部查询仍按 userId**：~~见 I-12~~ **R2 轮已改为按组织作用域读取**（§9 R2-I02）；预览之外的写路径（create / apply / adjust / complete / cancel）仍按 userId，随 Goal #3B。
3. **页面/组件级查询键未系统性地加组织前缀**：~~目前只有 4 个 hook 带前缀；其余靠切换时显式清理无前缀键~~ **R2 轮已系统性补齐**（§9 R2-I07）：组织数据查询全部带前缀并按 `orgId !== null` 门控，受保护区业务区按组织 key 重新挂载。
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

## 9. R2 评审修复轮（2026-11-24）

> 输入：R2 独立评审（13 个 `[Important]` 阻断项 R2-I01~I13 + 工作区卫生 1 项；另有 `[Nit]` / `[Pre-existing]` 若干）。
> 状态：**改动已提交**（`fb07201` / `c6fecbf` / `83f36f1` 及 E2E + 文档提交，见 §10.5 第 4 项）。§9.6 的未处理项保持原样。

### 9.1 工作区隔离

审查开始时工作区滞留 13 个与 PR #10 无关的部署改动。已原样移入 `stash@{0}`（`deploy: infra/compose + workflows + launch checklist (parked outside PR #10, R2 workspace isolation 2026-11-24)`）：9 个已修改（`.dockerignore`、`.github/workflows/{docker-build,relay-images}.yml`、`.gitignore`、`AGENTS.md`、`README.md`、`docs/LAUNCH-CHECKLIST.md`、`infra/compose/{compose.prod.yaml,deploy.sh}`）+ 4 个未跟踪（`infra/compose/.env.example`、`chat.env.example`、`nginx-http.conf.template`、`nginx-https.conf.template`）。恢复用 `git stash pop`；本轮对 `AGENTS.md` 的改动与 stash 里的部署文档改动不在同一处，预期可自动合并，pop 后请核对。

### 9.2 逐项处置（13 个阻断项全部修复）

| 编号 | 处置要点 | 回归测试（均做过变异验证：还原旧行为则对应用例变红） |
| --- | --- | --- |
| R2-I01 | 新增 `lockOrganizationForActor`（取组织锁 + 重读操作者行；不存在 / 跨组织 / 非 ACTIVE → 404 `ORGANIZATION_NOT_FOUND`，非法角色 → 403）。`updateRole` / `removeMember` / `invitation.create` / `revoke` 改用锁内最新角色；`revoke` 先验总资格再查行。`leave`（只禁用自己）与 `transferOwnership`（条件更新本身是原子校验）确认安全、未改 | `membership.spec.ts` 新增 11 条锁屏障用例（10 条竞态 + 1 条对照）；`default-organization.spec.ts` 7 条 |
| R2-I02 | 三个预览改以 actor 为读作用域：计划排期 / 修改预览（本位币取组织偏好，账户与计划按 `compatReadWhere`）；更正预览（目标归属、账本重放范围、偏好、关联计划均按组织）。写路径不变 | `organization-read-isolation.spec.ts` 新增 8 条（跨组织 IDOR、受邀成员算对、本位币取组织偏好） |
| R2-I03 | **与评审建议的做法不同，见 §9.5.1**：默认组织重新定义为「用户创建的最早的组织」；所有权转移前把仍靠所有者个人设置回落的组织偏好固化为 `OrganizationSettings` | 同上两个集成套件新增 7 条（另改写 1 条） |
| R2-I04 | 脱敏器：补缩写边界切词与词表（OTPCode / JWTToken / XAPIKey / cookies / bearer / accessKey 等全部命中）；产出限定为合法 JSON 值；任意二进制视图 → `[BINARY]`；跳过自有 `__proto__` 键。审计时间：DTO 叠加 `@IsISO8601({ strict: true })` + 服务层兜底 400 | `audit-sanitizer.spec.ts` +7、`audit.service.spec.ts` +2、`test/api/audit.spec.ts` +1 |
| R2-I05 | 回填 dry-run：全库模式不再按用户 id 绑定参数；`ownerMembershipsCreated`、历史 CLEAR、行主已读行、PlanChangeLog 父计划归属四处估算与写入对齐。核对脚本全部改 LEFT JOIN，无默认组织用户的行不再被静默丢弃 | `organization-migration.spec.ts` +3 |
| R2-I06 | 锁屏障改为「先持锁、再发请求」（`runBehindAdvisoryLock`）；新增 `raceBehindAdvisoryLock`，两处并发所有权转移用例改用它（双请求都过 Guard 后才在锁内竞争） | 既有用例改为确定性；相关套件连续 6 轮 135/135 无抖动 |
| R2-I07 | 新增 `OrganizationScopeBoundary`（受保护区业务区按组织 key 重新挂载，覆盖本地状态与命令式拉取）；22 个文件的组织数据查询补 `withOrgScope` + `enabled` 门控；`dataRequests.all` 纳入切换清理 | 新增 `organization-scope-boundary.spec.tsx` 3 条；`use-reminders.spec.tsx` +2 |
| R2-I08 | 审计表查询键按组织分桶；占位数据只在同一组织内沿用 | 新增 `audit-log-table.spec.tsx` 3 条 |
| R2-I09 | 流收尾改为**归属判定**：任何 `await` 之前先判定并注销自己的句柄（`releaseActiveStreamAbort`），没有后来者才清创建态 | `use-chat.spec.tsx` +2（跨组织、同组织） |
| R2-I10 | 新增 `lib/auth/session-reset.ts`（`resetSessionContext` / `beginAuthenticatedSession`），登录 / 注册 / 登出 / 401 四处共用；登录与注册在写入新 token **之前**重置；`resetSession` 连同会话级拒绝集合一起清；路由分流在选中组织落地前返回 `loading` | 新增 `session-reset.spec.ts` 4 条；`client.spec.ts` +1；`use-organizations.spec.tsx` +1（并改写 1 条） |
| R2-I11 | 建账向导提交成功后 `router.replace(safeRedirectPath(redirect) ?? "/home")` | **无自动化用例**（单行改动，位于组件内；邀请回跳链路待 E2E 人工验收时顺带确认） |
| R2-I12 | 三层：服务端 `mask.ts` 补路径明文 + URL 编码态两条邀请规则；前端正则排除反斜杠并补编码态；`monitor.ts` 对 `pageUrl`、序列化信封整体脱敏，`beforeSend` 增加事件树全量字符串脱敏 `maskEventStrings` | 前端 `mask.spec.ts` +3、`monitor.spec.ts` +2；服务端 `mask.spec.ts` +3、`server.spec.ts` +1（落盘文件与 GET 读回都不含明文） |
| R2-I13 | E2E：`beforeAll` 为两名用户都建账并在所有者组织造一条具名计划；T-ORG-010 补组织选择；新增 T-ORG-007B（停在计划列表页切换组织，旧组织数据不残留） | 类型检查通过、`playwright --list` 可发现 11 条；**未运行**（§9.4） |

### 9.3 复验证据（全部改动落定后）

- **后端**：unit 628（43 文件，另 1 todo）/ api 375（21）/ integration 122（16）/ infra 18 —— 0 failed。
- **前端与其余**：web 316（33 文件；上一轮 295 / 30）/ money 64 / dev-log 29 / scripts 7 —— 0 failed。
- **仓库级**：`check:structure` 通过；`lint`（ESLint + 结构守卫 + 两包 `lint-observe` 变更文件策略）通过；`typecheck` 4/4 任务通过。
- **OpenAPI 一致性**：`generate:api` 重跑零 diff（`openapi.json` `756cac14…` / `schema.gen.ts` `1364bc1e…`，61 条路径 / 142 个 schema 无增减）。
- **E2E**：`15-organization.spec.ts` 独立类型检查通过；**NOT_RUN**（AI 禁启服务）。
- 测试产物：`playwright --list` 会在 `e2e/test-results/` 生成报告目录，已按仓规清理；仓库内无遗留运行产物。

### 9.4 需要人工完成

1. **跑 E2E**：§5 手册。本轮新增与改动点——T-ORG-002 / T-ORG-008 不再与建账重定向竞态、T-ORG-010 不再必挂、T-ORG-007B 为新用例（首次运行请校准 `还没有换汇计划` 与计划卡名称定位）。
2. **提交本轮改动**（80 个文件）并把 `stash@{0}` 的部署改动恢复到独立分支。建议按三组提交并附验证戳记：后端 `Verified: unit, property, api, integration, infra`；前端 + 脱敏 `Verified: unit, web, dev-log`；E2E + 文档 `Verified: none (E2E 需人类启服；类型检查通过)`。
3. **N-05 / N-08 的条目标题**仍需对照评审原文确认（本轮输入里没有这两条的原文）。

### 9.5 与评审不一致或需要知悉的地方

1. **R2-I03 的做法与评审建议不同**。评审建议「转移时固化 OrganizationSettings + 仅首个归属组织可作为兼容回落目标」。逐条推演后只做前者不够：固化能保住被转走的组织，但原所有者的个人设置仍会变成他**后建组织**的偏好（对该组织全体成员可见），MIG-B 重跑也会把他的存量行灌进后建组织。只把「最早的 ACTIVE OWNER」换成「最早的成员关系」同样不行：存量用户若在回填前先受邀加入他人组织，回填会把他的全部个人账本灌进那个组织。最终口径是「用户**创建**的最早的组织」，以「该组织的第一个成员，且成员关系与组织同事务创建」识别——创建者身份不随角色 / 状态变化。该识别依赖「建组织一律嵌套写入」这一现状（三个路径都已如此，并由测试钉住）；将来若有路径不嵌套写入，判定会 fail-closed（组织显示未建账，问题会立刻暴露而不是静默泄露）。
2. **R2-I04 中一条审查论断未能复现**：`NaN` / `Infinity` 放进审计 detail **不会**被 Prisma 拒绝——实测被接受并静默存成 `null`（JSON 序列化的结果）。归一化仍保留（显式优于隐式）。已复现的部分：function / Symbol 被 Prisma 拒绝并回滚业务事务；`Int32Array` 等以十进制明文落盘；自有 `__proto__` 键的属性会被提升进落库的 detail（可向审计记录注入伪造字段）。
3. **R2-I09 修复过程中踩过并已纠正的坑**：最初用「组织上下文是否已变」决定是否跳过 `endStream`，结果在「组织变了但聊天运行时态未被重置」的路径上流式态永不清理、**输入框永久锁死**（比原缺陷更糟），被既有用例拦下。正确判据是**句柄归属**而非上下文。
4. **`useOrganizationRouting` 语义变化**：单组织用户在选择落到 store 之前现在是 `loading`（此前首帧即 `ready`），多一帧加载态，不闪现选择页。

### 9.6 未处理项

- **`[Nit]` 未处理**（本轮以阻断项为限，除下一条）：`:id` 路由缺 `@ApiParam`；`assertNoOrphanRows` 未含 `cost_lots` 预检；`reminder.service` 候选查询无 `take` 上限；`decline` 幂等判断位于锁前；纯 OTP 成员 `email: null`；`permission-policy` 建议改 `Object.hasOwn`；DENIED 审计缺 `requestId`；`transaction` / `report` 二次按 ID 查关联行未补纵深过滤；`compatReadPredicate` 无调用方；`tokenCount` 被误脱敏；前端若干体验项（切换器重拉期间短暂显示旧名、`OrganizationPicker` 无登出入口、5xx 时持续加载态等）；`safe-redirect-path` 未拒绝反斜杠前缀；主动中止 SSE 时 `AbortError` 被上报为网络错误。
- **顺带解决的 `[Nit]`**：默认组织排序补了 `id ASC` 决胜键；深度上限 − 1 处的 Decimal 不再多计一层被截断。
- **`[Pre-existing]`**：密码注册与纯 OTP 邮箱身份未互斥——记入认证加固 backlog，未动。
- **R2 组织删除功能的设计提醒**：删除某个用户的个人工作台后，「创建的最早组织」会落到他的下一个组织；届时需一并处理该用户的存量 NULL 行。

## 10. R3 评审修复轮（2026-11-24）

> 输入：R3 独立评审（6 个 `[Important]` R3-I01~I06，另有 `[Nit]` 与 `[Pre-existing]` 若干）。
> 处置原则同 §8.2：逐条核实后采纳；与评审建议不一致之处写明理由。
> 状态：**改动已提交**（清单见 §10.5 第 4 项；本地验证见 §10.4「终验」）。提交经 `AGENTS.md` 门禁政策的豁免通道放行，扫描核实与豁免记录见 `MIMOSA-GATE-20261105.md` §7。PR #10 待人工评审合入 `dev`。

### 10.1 阻断项逐条处置

| 编号 | 核实结论 | 处置 | 回归测试 |
| --- | --- | --- | --- |
| R3-I01 | 成立。仓库外挂真实模块复现：接受后组织已切换，页面回弹成未接受的表单，边界挂载 2 次 | 新增纯函数 `isOrglessRouteAllowed`（按路径段匹配）；`OrganizationScopeBoundary` 增加 `bypass`；路由分流与边界共用同一判定。**与评审建议的差异**：回归测试放在边界 spec，不另写「手包一层边界」的页面测试——那种接线是测试自己搭的，证明不了 layout 的接线；layout 接线由 E2E T-ORG-004 兜底 | `organization-scope-boundary.spec.tsx` +3（变异验证：去掉 bypass 的 key 逻辑后 3 条全红）；`use-organizations.spec.tsx` +1 |
| R3-I02 | 成立。复现：`router.replace` 调用 0 次、按钮已被布局卸载 | `mutateAsync().then(…)`。评审给的两种写法（另一种是 hook 级回调内先导航再清选择）都实测可行，取改动局部的一种 | 新增 `leave-organization-button.spec.tsx` 3 条（修复前红：导航 0 次） |
| R3-I03 | 成立（代码核对）：计划写路径不落 `organizationId`，迁移里也没有触发器或默认值代填；受邀者在所有者组织是非默认上下文，读不到 | 采纳方案 (a)：计划造在受邀者名下，从「有计划」切到「为空」再切回。不选 (b)：要把 007B 挪到 009 之后，编号乱序或改名，交接文档的引用都要跟 | E2E T-ORG-007B 改写并通过独立类型检查，**未运行** |
| R3-I04 | 逻辑成立，但**生产不可达**，降为加固项。实测：真实 SSE 解析器在 abort 时读取立即以 AbortError 拒绝，按真实用户节奏现状代码不被破坏；只有「同一段同步代码内完成切换、切回、发送」才触发，用户操作做不出来。评审标题里的「R2-I13 仍未闭环 — 100% 必败」是从上一条串过来的，评审未给这一条的复现证据 | 评审的 4 处改动 + **配套改动**：`abortActiveStream()` 自身重置聊天运行时态（三处调用点本来就这么成对调用）。**单独照搬评审的 4 处会让既有「评审 I-18」用例变红**（实测 16/17），即 §9.5.3 记录过的输入框锁死：该门控隐含「外部中止必伴随运行时态重置」，原先只靠调用点自律 | `use-chat.spec.tsx` +1（A→B→A 同会话重入；用例注明前提是「传输层未及时响应 abort」的防御性建模）；既有 17 条保持全绿 |
| R3-I05 | 成立。实测现规则对双层、三层编码均泄漏 | 两份 `mask.ts` 改为 `(%(?:25)*2f)`。**定级校正**：dev-log 仅 `NODE_ENV=development` 且配置了上报地址才启用，服务端只接受 localhost 来源，不进生产——它是 R2-I12 的收尾，不是生产漏洞 | 两份 `mask.spec.ts` 各 +2（修复前红）；新增 `scripts/__tests__/mask-parity.spec.ts`，同一组向量跑两份实现（两份规则已漂移两次：R2-I12、R3-I05） |
| R3-I06 | 成立。实测：该值通过 DTO 两道校验，UTC 年为 10000；本地库只读查询 UTC 年 9999 正常返回、10000 抛 `PrismaClientUnknownRequestError` | `parseAuditFilterTime` 补 UTC 年份边界（0001–9999），上界与 Prisma 实际支持范围一致 | `audit.service.spec.ts` +1、`test/api/audit.spec.ts` +1（**NOT_RUN**，待启库） |

### 10.2 评审清单之外（评估过程中发现，一并处理）

1. **同类面 `transactedAt`**：`POST /api/transactions` 的日期用非 strict 的 `@IsISO8601`，实测放行 `2026-W01-1`、`20261123` 等写法，`new Date()` 得 Invalid Date；范围校验对 NaN 的比较恒为假，无效值会进到 Prisma（500）。与 R3-I06 同类。修复：新增纯函数 `assertValidTransactedAt`（无效时刻与 UTC 年份越界都 400），在查库之前拦截，与 usage 的 `parseUsedAt` 同口径。`correction.baseUpdatedAt` 已有 NaN 拦截，usage 已有 `parseUsedAt`，排查后仅此一处。
2. **`OrganizationPicker` 的 `onPicked` 回调**：与 R3-I02 同一机制（hook 级切换组织后组件被卸载，调用点回调永不派发），且没有任何调用方传参。已删除。
3. **脱敏器无分隔符整词键**：写属性测试时发现全小写、无分隔符的整词键（`accesstoken`、`authcode`）切不成两个词，短语规则匹配不到，而单词表只手工收录了其中一部分。已改为按敏感短语拼接派生，不再手工同步两处。

### 10.3 `[Nit]` / `[Pre-existing]` 处置

| 项 | 处置 |
| --- | --- |
| N1 `OrganizationService.update` 补锁内重读 | 本轮做：`lockOrganizationForActor` + 按最新角色判 `organization.update`。`test/api/organization.spec.ts` 新增 1 条锁屏障用例（**NOT_RUN**） |
| N2 `updateRole` / `removeMember` / `transferOwnership` 顺位 | 延后：无提权面，只是错误码顺序的一致性 |
| N3 显式 `organizations.created_by_id` | 同意方向，属 schema 迁移，记入 Goal #3B（MIG-C） |
| N4 脱敏器复合键 | 本轮做：词尾序号不参与比对、短语匹配纳入复数形态；2 条属性测试（全部敏感短语 × 序号 / 复数 / 四种拼接风格；对偶：业务复合键加序号 / 复数仍不判敏感）。`mask.ts` 吃右括号（过脱敏、不泄露）与更正预览补测未做 |
| N5 文档口径 | 本轮做：§5 的 11 条口径、`AGENTS.md` 目录树补 `lib/auth/`、文件归属表补 3 条 |
| P1 审计 detail 截断拆开 emoji 代理对 | 本轮做（与 N4 同一文件）：有损压缩与降级预览改按码点截断。注意：检查产出必须遍历值里的字符串，`JSON.stringify` 会把落单代理项转义掉，先序列化再检查永远查不到 |

### 10.4 验证证据

- **类型与静态**：`typecheck` 4/4 通过；`lint` 通过（ESLint + 结构守卫 + 两包 `lint-observe` 门禁）。`lint-observe` 第一次拦下本轮在 `audit-sanitizer.ts` 新增的 2 处非空断言（新增文件要求零警告），已改掉。
- **前端与其余**：web 326（34 文件；上一轮 316 / 33）、dev-log 31（上一轮 29）、money 64、scripts 8（上一轮 7）—— 0 failed。
- **后端 unit**：623 passed / 13 skipped / 1 todo（43 文件中 41 个通过）——skipped 全部因为数据库未运行，集中在 2 个文件：`src/audit/audit.service.spec.ts`（8 条，含本轮新增的 I06 用例）与 `src/account/backfill-cost-lots.script.spec.ts`（5 条，本轮未改动）。按上一轮基线推算，启库后应为 636 passed。
- **未执行（NOT_RUN）**：`test/api/`、`test/integration/`、`test/prisma.spec.ts` 全部，以及上面 2 个 unit 文件。本轮新增的用例里有 **4 条**在其中，尚未见过红绿：I06 的服务层与接口各 1 条、`transactedAt` 同类面 1 条（`#11b`）、N1 锁屏障 1 条。
- **E2E**：`15-organization.spec.ts` 通过独立类型检查，未运行。
- **终验（11-24）· 仓库级与前端**：`check:structure`；`lint`（两个 `lint-observe` 任务实际执行，非缓存）；`typecheck` 4/4（首次 4 个任务全是 turbo 缓存命中，已 `--force` 重跑确认）；web 326（34 文件）/ money 64 / dev-log 31 / scripts 8 —— 0 failed，与本节上面的数字一致。
- **终验 · 后端（21:30 启库后，Node 24.15.0）**：unit 636 passed / 1 todo（43 文件，0 skipped）/ api 378（21）/ integration 122（16）/ infra 18 —— 0 failed，退出码 0。上面列为「尚未见过红绿」的 4 条逐条确认通过：服务层与接口层的 R3-I06、`#11b`、R3-N1。
- **终验 · 库未运行时 unit 不算通过**：20:27 那次（库未启动）unit 是 623 passed / 13 skipped / 1 todo，但**退出码 1**——`src/audit/audit.service.spec.ts` 与 `src/account/backfill-cost-lots.script.spec.ts` 的 `beforeAll` 连不上库，按套件级失败计。库套件只打项目配置的库（`localhost:5432`）；`5433` 是 Postgres.app 的非项目实例，不可替代。
- **终验 · 两条新用例不独立**：服务层 R3-I06 与 R3-N1 依赖同文件前序用例造的数据，按用例名过滤单独运行会失败（`expected 0 to be greater than 0` / `PrismaClientValidationError`），整文件运行通过。未改。
- **终验 · E2E：11/11 通过**（第 3 轮，21:53，关闭重试，spec 未改）。T-ORG-004 接受后停在「已加入组织 / 进入工作台」且不回弹；T-ORG-007B 切换组织后「还没有换汇计划」与计划卡定位准确；T-ORG-008 退出后回到 `/home`；T-ORG-010 登出后组织选择被清空。spec 用到的 23 个 testid 与 6 条文案逐个对照前端代码，全部存在。前提：dev 服务须带 E2E 限流参数启动——全局限流默认 10 次/分钟（`services/chat/src/app.module.ts:12`），第 2 轮 T-ORG-007 即因 `/api/organizations` 被 429、页面停在「组织列表加载失败」而失败。

### 10.5 需要人工完成

1. **后端已补跑通过**（11-24 21:30，见 §10.4「终验 · 后端」）。提醒：项目库是 `pg_ctl` 启动的实例，机器重启后不自启，先 `bun run db:status` 确认，未运行则 `bun run db:up`。
2. **E2E 已跑通（11/11，见 §10.4）**。再跑时的口径：dev 服务须带 E2E 限流参数启动——`THROTTLE_GLOBAL_LIMIT=500 AUTH_THROTTLE_LIMIT=200 AUTH_OTP_THROTTLE_LIMIT=200 bun run dev`（与 `run-e2e-tests.sh` 导出的一致）；该脚本会自行启停服务，AI 不得使用，应直接调 Playwright 打已启动的服务。本机原缺 Playwright 1.61.1 对应的 chromium 1228，已 `bunx playwright install chromium` 补装（安装流程顺带清掉了无引用的 chromium 1234 缓存，其他项目若需要须重装）。
3. **夹具缺口（未改，待定）**：Playwright 重试会重跑 `beforeAll` 并复用同一批用户，`seedOnboarding` 重复提交被 409 `ONBOARDING_ALREADY_COMPLETED` 拒绝（`e2e/helpers/api-seeder.ts:200`），所以 `retries=1` 对本 spec 实际失效——重试必定败在夹具阶段，看不到用例本身的结果。由本轮新增的建账夹具引入。
4. **已提交（经 `AGENTS.md` 门禁政策的豁免通道）**：`fb07201` 后端 32 个文件（`Verified: unit, property, api, integration, infra`）；`c6fecbf` 前端 + 双端脱敏 54 个文件（`Verified: web, dev-log, scripts`）；`83f36f1` 组织信息页重复 key 修复（`Verified: web, e2e`）；E2E 与文档随本文件所在的提交落盘（`Verified: e2e`）。门禁拦截、扫描核实与豁免记录见 `MIMOSA-GATE-20261105.md` §7。
5. **未混入的改动**：`clients/chat-web/next-env.d.ts` 是 `bun run dev` 启动时 Next.js 自动改写的，本次未提交。注意 `dev` 上该文件提交的正是这种 dev 写法（`./.next/dev/types/`），本分支提交的是 `./.next/types/`——合入后它会翻回后者，本地再跑 `bun run dev` 又会变脏。`stash@{0}` 的部署改动保持原样。R4 唯一的 `[Nit]`（`services/chat/src/audit/audit-sanitizer.ts:161` 的 `replace` → `replaceAll`）已随后端一组提交；R4 评审的其余内容不在本轮输入里，未补记。
6. **React 重复 key（已修，`83f36f1`）**：`clients/chat-web/app/(protected)/organization/page.tsx` 上 `OrganizationForm` 与 `CreateOrganizationCard` 是同级兄弟，却共用 `key={activeOrganizationId}`，每次打开组织信息页控制台都报 `Encountered two children with the same key`。已改为带不同前缀的 key；修复后复跑 E2E 11/11，该报错 0 次。E2E 不断言控制台，这个缺陷是看运行日志才发现的。
7. **本 PR 之外的待处理**：`clients/chat-web/package.json:30` 把 `next` 锁在 `16.2.3`，命中 CVE-2026-64642，修复版本 `16.2.11`（Mimosa 依赖检查发现，不参与门禁）；第 3 项的夹具缺口；§10.4「终验 · 两条新用例不独立」；Mimosa 门禁的根治路径见 `MIMOSA-GATE-20261105.md` §4。

### 10.6 有意不做 / 已知限制

- 全小写、词间带序号且无分隔符的键（`api1key`）无法切词，脱敏器不覆盖；这不是真实的键名形态。
- R3-I04 的修复依赖「外部中止 ⇒ 运行时态重置」这一配对，现由 `abortActiveStream` 自身保证；今后若新增「只中止不重置」的调用路径，必须同时改 `use-chat` 的收尾判定。
- 豁免路由（`/invitations/*`）的边界不再随组织重挂载，前提是子树内的组织数据查询按组织分键（`withOrgScope` + `enabled` 门控）；提醒铃铛已满足，后续往该子树加组织数据查询时须遵守。
