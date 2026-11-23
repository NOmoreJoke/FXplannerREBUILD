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
  5. `[Nit]`（未修、记 backlog）`organizations.current` 键不含组织 id，切换后 capabilities 有短暂旧值窗（后端强制校验兜底，仅按钮显隐瞬时错位）——建议随 #3B 前端全量带头时一并键化。
  6. `[Nit]`（未修、记 backlog）PermissionGuard 拒绝前 await DENIED 审计，审计库挂起会推迟 403（try/catch 不吞错；可加超时）。
  7. `[Nit]`（未修、记 backlog）layout 单组织自动选中分支依赖后续请求兜底清缓存（无前缀键由 clearOrganizationScopedQueries 统一覆盖后已缓解）。
- **R2 增量复核（修复提交后）**：`Verdict: 0 [Important], 3 [Nit], 0 [Pre-existing]`——**[Important] 清零**。四项修复全部 [PASS]（清理列表前缀匹配覆盖实际键形态、数组头无回归、P2002 映射精确不误吞、工厂键引用完整）。残余 3 个 [Nit]：
  1. `organizations.current` 键不含组织 id（R1 已记 backlog）；
  2. transfer 端点 `@ApiConflictResponse` 未列 TRANSFER_CONFLICT、并发 409 映射无专测——**本次收尾已补**（注解 + membership.spec 并发双提交用例）；
  3. DENIED 审计 await 推迟 403（R1 已记 backlog）。

## 5. L3 人工 E2E 跑测清单（NOT_RUN 项）

1. `e2e/modules/15-organization.spec.ts`（本批新增骨架，T-ORG-001..007：单组织直达/组织信息/邀请链接/受邀接受/角色调整/审计只读/Viewer 边界）——**定位器按实际 UI 校准后运行**；
2. 既有全量 `e2e/modules/`（01–14，含 T-AI-003 豁免单在案：预期「仅 T-AI-003 显式失败」）；
3. 运行手册：`FXPLANNER_E2E_QUOTE_DATABASE=fxplanner_new_db_local ./e2e/scripts/run-e2e-tests.sh --headless`（见 PRE-GOAL3A-CLOSURE §5）；跑完 `rm -rf e2e/test-results`。

## 6. Goal #3B 启动准入核对（W18 兼容窗口遗留清单）

以下路径在 Goal #3B（业务写 Actor 化 + DataRequest 拆分）收口，本批有意保留：

1. **写路径 userId 语义**：业务写接口（POST/PATCH/DELETE account/plan/transaction/usage/correction/onboarding/settings）仍按 userId 写入（organizationId 落 NULL，兼容窗口由读侧 `compatReadWhere` NULL 分支可见）；Goal #3B 切 ActorContext 写 + `compatReadWhere` 移除。
2. **注册兜底**：`auth.service.register` 建默认组织（W18 落地）；**onboarding complete 建 OrganizationSettings 的组织化**未做（GET /settings 以 OrganizationSettings 优先 + UserSettings 回落兼容，PRE 语义正确）。
3. **reminder 生成**：仍按 userId 生成（W18 注释在案）；组织级生成 + ReminderRead 写路径随 #3B。
4. **DataRequest**：scope 列已迁移（PERSONAL 默认、历史 CLEAR 由 MIG-B 映射 ORGANIZATION），但**请求创建/锁逻辑未拆**（个人/组织两类锁 = Goal #3B W22-W24 范围）。
5. **前端兼容**：未选组织时业务请求不带组织头（后端唯一默认组织回落）；Goal #3B 切写后前端全量带头并关闭回落（BusinessOrgScopeGuard 收敛为严格 400）。

## 7. 交接人下一步

- [ ] 人工启服跑 §5 E2E 清单（T-ORG 骨架需按实际渲染校准定位器）
- [ ] 对抗审意见（§4 回填后）[Important] 项清零确认
- [ ] Draft PR 评审后转 Ready、合入 `dev`，随后以 `docs/handoff/GOAL-3B-TOB-R1-LEDGER-WRITE-DATA-SPLIT-20261123.md` 启动 Goal #3B
