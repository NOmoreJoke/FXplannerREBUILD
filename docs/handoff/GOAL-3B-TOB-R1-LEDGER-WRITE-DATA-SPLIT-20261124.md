# Goal #3B — FXplannerREBUILD · ToB R1 共享账本写 Actor 化、成员已读与双域数据请求拆分（P4–P5，Orchestrator 双引擎编排版）

> 适用阶段：Phase 3 · ToB R1 Part B（对应 `技术方案.md` P4 业务写接口 Actor 化与同事务审计 + P5 `DataRequest` 个人/组织双域拆分与双锁重构）
> 接力序列：`Goal #3A (PR #10, W13–W21 + R1–R4)` → **`Goal #3B (W22–W28)`** → `Goal #3C (W29–W32)` → `Goal #4 (R2 Agent)`
> 总指挥（Commander）：Antigravity Orchestrator（`carbon` 模型）
> 开发与互审双引擎：通过 Computer Use 调度桌面端 **ZCode** 与 **MiniMax Code**
> 基线状态：PR #10（Goal #3A）已合入 `dev`（merge commit `690ecfa`），全量 E2E 已由人类跑完并清理
> 修订说明：基于 `docs/handoff/GOAL-3B-TOB-R1-LEDGER-WRITE-DATA-SPLIT-20261123.md` 与 `2026-11-24` 初稿升级，完整保留 Goal #3A（PR #10）R1–R4 架构不变量与 W22–W28 技术规格，新增 Antigravity Orchestrator（`carbon`）总指挥、Computer Use 调度 ZCode / MiniMax Code 迭代开发、逐任务独立对抗审查与修复后提交闭环。
> 上游真源：`AGENTS.md`、`docs/VERIFY.md`、`docs/VIBE-CODING-PLAYBOOK.md`、`changes/tob-agent-workspace/需求文档.md`（§7.3, §8, §9.1, §11, §15.3, §15.5）、`changes/tob-agent-workspace/技术方案.md`（§4.3–§4.4, §5.2, §6, §9, §10.2–§10.3, §13.1, §14）、`docs/handoff/OVERNIGHT-TOB-R1-A-20261123.md`
> 建议特性分支：`feat/tob-r1-b-ledger-write-data-split`

---

## 1. 开工前只读硬门核验（第一步，不满足立即停机）

- 仓库：`/Users/kyle/Documents/工作/知爻/FXplannerREBUILD`
- 核验清单：
  1. `git fetch origin && git status -s` 与 `git log -n 1 --oneline dev`：确认 **PR #10（Goal #3A）已合入 `dev`**（merge commit `690ecfa`），`dev` 与 `origin/dev` 同步，工作区完全干净（确认无 `clients/chat-web/next-env.d.ts` 脏改动、无 `e2e/test-results/` 或 `services/chat/logs/` 残留，且 `stash@{0}` 部署改动保持独立未混入）。
  2. 确认本地 PostgreSQL 在线（`bun run db:status`）且迁移无漂移（在 `services/chat` 加载 `.env.local` 后 `bunx prisma migrate status` 显示 `20 migrations` 全量同步），测前 `plan_allocations` / `usage_lot_allocations` 孤儿数为 `0`。
  3. **Computer Use 与双引擎环境核验**：确认 macOS 桌面端 **ZCode** 与 **MiniMax Code** 均可正常启动且已登录，工作项目均指向 `/Users/kyle/Documents/工作/知爻/FXplannerREBUILD` 且无未保存的冲突会话；确认 Computer Use 截屏/键鼠操作权限可用。
  4. 必读基线（禁止跳读）：
     - `AGENTS.md`（目录树铁律、文件归属表、R2–R4 新增前端/后端不变量）
     - `docs/VERIFY.md`（Diff 触发检查、三类防愚弄测试、3 轮自愈熔断）
     - `docs/VIBE-CODING-PLAYBOOK.md`（六步标准作业闭环与 FXplanner 5 项高危加审面）
     - `docs/handoff/OVERNIGHT-TOB-R1-A-20261123.md` §6（Goal #3B 兼容窗口遗留清单）、§9.5–§9.6、§10.3
     - `changes/tob-agent-workspace/技术方案.md` §4.3–§4.4、§5.2–§5.3、§6.2、§9、§12.2、§13.1
  5. 通过后从最新 `dev` 切出特性分支：`git checkout -b feat/tob-r1-b-ledger-write-data-split dev`（若分支已存在且基底一致可直接切入并核验）。

---

## 2. 总指挥编排体系与单切片闭环流程（Orchestrator + Computer Use + ZCode / MiniMax Code）

### 2.1 角色职责与会话纪律

- **Antigravity Orchestrator（`carbon` 模型）**：担任**总指挥、唯一规划者、确定性验证官、终审裁判与唯一 Git 提交者**。严格遵守会话工程纪律：
  - 规划只在开头一次性写全并锁定，执行阶段不反复向人类追问；
  - 仅当同一验证连续失败 2 次或命中 Re-plan 条件时才切回规划调整方案（单会话模型切换 ≤ 3 次）；
  - 系统约束、前置基线与长素材放在上下文前部保持不变，每个切片的执行/审查结果仅按顺序往后追加台账。
- **ZCode & MiniMax Code（桌面端执行器，由 Computer Use 调度）**：分别承担指定切片的代码实现与局部单测，以及**交叉异构独立对抗审查**（写代码与审代码绝不落入同一工具）。
  - **严禁**两款桌面端自行执行 `git commit`、`git push`、`git merge`、切换分支或启动前后端服务；
  - **严禁**启动 Cursor Cloud Agent 或在仓库外写入修改。

### 2.2 防冲突调度策略

- **默认模式 A（推荐，单工作区串行轮转 + 异构互审）**：按 `W22 → W28` 顺序每次仅激活一个写任务，彻底避免两个桌面端同时改写 `services/chat/prisma/schema.prisma`、`clients/chat-web/lib/api/openapi.json` 或争抢 `.git/index.lock`。
- **可选模式 B（Worktree 物理隔离并行）**：仅当 Orchestrator 只读核实两个相邻切片的改动文件完全不相交（不共改 Prisma schema、OpenAPI 契约、权限策略真源与共享锁定文件）时，方可先运行 `bun run worktree:create` 创建独立 worktree，再让 ZCode 与 MiniMax Code 各自打开不同目录并发开发；严禁双引擎同时写入同一工作树。

### 2.3 Computer Use 调度纪律与容错

- 每次通过 Computer Use 派发任务前，必须先截屏核验目标桌面端显示的工作目录与当前 Git 分支为 `/Users/kyle/Documents/工作/知爻/FXplannerREBUILD` / `feat/tob-r1-b-ledger-write-data-split`。
- 每个开发切片和每次对抗审查都必须**新建独立任务/会话**（建议命名：`Goal-3B / Wxx 开发`、`Goal-3B / Wxx 对抗审 R1`），禁止在一个长对话里串联多个不相关切片导致上下文污染。
- **15 分钟卡死/报错掉线熔断**：通过 Computer Use 观察界面状态，并配合终端检查 `git status` 与文件 mtime；单个执行器超过 15 分钟无实质改动与产出，或遇到不可恢复的工具崩溃/弹窗卡死，判定掉线——立即保留现场 diff，切换另一执行器续做并写入交接台账。
- **过程截图严禁落仓**：Computer Use 辅助截图仅保存在会话临时路径，禁止放入仓库内任何目录（遵守 `AGENTS.md` 与 `docs/handoff/OVERNIGHT-ZCODE-20261105.md:69`）。
- **不可用降级披露**：若某一桌面端因账号、额度或系统弹窗异常暂时无法执行对抗审，必须在 `docs/handoff/OVERNIGHT-TOB-R1-B-YYYYMMDD.md` 显式披露原因，降级为外部异构 CLI（如 Codex CLI）或 Antigravity 独立只读审查 Agent 补齐，**绝不允许跳过对抗审直接提交**。

### 2.4 单切片 6 步强制闭环（W22–W28 每片必走，缺一步不得进下一片）

1. **Step A · Computer Use 派发开发任务**：使用 2.6 节「开发任务派单模板」向当前切片主开发引擎（ZCode 或 MiniMax Code）下发完整任务边界；要求完成实现、必要时运行 `bun run --cwd clients/chat-web generate:api`、编写并跑通本切片新增测试；完成后仅在对话输出改动摘要与自测日志，**严禁自己 commit**。
2. **Step B · Orchestrator 确定性初验（廉价检查先行）**：Orchestrator 在本机终端执行 Diff 触发核对（`docs/VERIFY.md` §2）+ `bun run check:structure && bun run lint && bun run typecheck` + 本切片受影响 L1/L2 测试套件（含单用例 `-t` 独立运行校验与 `generate:api` 双跑零 diff 校验）；若未全绿，将准确报错与 `路径:行号` 派回原执行器修复（遵循 3 轮自愈熔断）。
3. **Step C · 异构独立对抗性审查**：通过 Computer Use 在**另一桌面端工具**（非本片开发者）新建只读审查任务，配合 Orchestrator（`carbon`）严格从 `dev` 基线读取 `AGENTS.md`、`eslint.config.mjs` 与 `docs/VERIFY.md` 作为裁判标准（被审改动不得修改门禁规则），执行对抗审；强制输出三态标签 **`[Important]` / `[Nit]` / `[Pre-existing]`**，每条必须附 `路径:行号` + 原文/复现证据；重点围堵 6 项高危面：
   1. 同事务审计原子性（账改与 `AuditLog` 严格同提交/同回滚）；
   2. 锁内重读操作者角色（`lockOrganizationForActor`，禁止沿用 Guard 放行前旧 `actor.role`）；
   3. Service 零 `userId` 绕过组织查询与跨组织统一 `404` 隔离；
   4. `Decimal` 金额/成本/占比与 CSV 导出零原生 `Number()` 浮点混入；
   5. UTC+8 日界划分与同日 FIFO 精确时刻排序不被截断破坏；
   6. 测试无 `test.skip`、无硬编码 `sleep`、无只测 mock 的同义反复断言。
4. **Step D · 对抗修复与回归复验闭环**：只要存在任意 `[Important]`（或 Orchestrator 判定需本轮收口的 `[Nit]`），即由 Orchestrator 将带 `路径:行号` 的修复清单通过 Computer Use 派回原执行器修改；修复后重新执行 **Step B 确定性复测 + Step C 增量对抗复审**，循环直至 **`[Important] = 0` 且受影响验证 0 failed**。若同一问题连续 3 轮未闭环，立即熔断停机保留现场并汇报人类。
5. **Step E · Orchestrator 规范提交**：确认 `git status -s` 无临时文件、测试产物或 `clients/chat-web/next-env.d.ts` 脏改动后，由 Orchestrator 统一执行 Conventional Commit（每切片 1 个原子 commit，头部对应第 4 节约定，正文尾部附 `Verified: ...` 与 `Adversarial-Review: R<n> 0 [Important] PASS`）；若遇 Mimosa hook 结构性误报，严格按 `docs/VERIFY.md` §3 与 `docs/handoff/MIMOSA-GATE-20261105.md` 留痕处理。
6. **Step F · 台账追加**：将本切片的主开发引擎、对抗审引擎、对抗审轮次、阻断项修复摘要、测试实测计数与 Commit SHA 追加记录到 `docs/handoff/OVERNIGHT-TOB-R1-B-YYYYMMDD.md`，随后进入下一切片。

### 2.5 W22–W28 双引擎分工矩阵

| 切片 | 切片主题 | 主开发引擎（Computer Use） | 异构对抗审引擎（Computer Use + Orchestrator） | 提交准入条件 |
| --- | --- | --- | --- | --- |
| **W22** | 个人/组织设置分离 + 组织独立建账 + `OnboardingService` 并发锁 | ZCode | MiniMax Code + Orchestrator (`carbon`) | Step B 全绿 + `[Important] = 0` |
| **W23** | `Transaction` 与 `Plan` 写接口 Actor 化、并发锁与同事务审计 | MiniMax Code | ZCode + Orchestrator (`carbon`) | Step B 全绿 + `[Important] = 0` |
| **W24** | `Usage`、组织级 `USAGE` 更正与共享账本 FIFO 重放 | ZCode | MiniMax Code + Orchestrator (`carbon`) | Step B 全绿 + `[Important] = 0` |
| **W25** | 成员级 `ReminderRead`、报告核验与 `AiConversation` 全端点绑定 | MiniMax Code | ZCode + Orchestrator (`carbon`) | Step B 全绿 + `[Important] = 0` |
| **W26** | `DataRequest` 双域拆分、`CHECK` 约束、最后 Owner 保护与 CSV 精度修复 | ZCode | MiniMax Code + Orchestrator (`carbon`) | Step B 全绿 + `[Important] = 0` |
| **W27** | 双锁守卫拆分（`PersonalAccountLockGuard` + `OrganizationLockGuard`）与下载重验 | MiniMax Code | ZCode + Orchestrator (`carbon`) | Step B 全绿 + `[Important] = 0` |
| **W28** | 前端权限感知交互、双域数据中心页与兼容收口 | ZCode | MiniMax Code + Orchestrator (`carbon`) | Step B 全绿 + `[Important] = 0` |

> 注：若任一桌面端在某切片发生掉线或额度耗尽，Orchestrator 可动态交换该切片的执行/审阅分配，但必须保证**同一切片的开发者与对抗审查者始终异构（分属不同工具/模型）**，并在台账显式记录。

### 2.6 标准化 Computer Use 派单模板

**模板 1：切片开发任务派单模板（发给当前切片主开发引擎）**

```text
【任务】FXplannerREBUILD · Goal #3B · <Wxx 切片名称>（仅写代码与自测，禁止提交 Git）
工作目录：/Users/kyle/Documents/工作/知爻/FXplannerREBUILD
当前分支：feat/tob-r1-b-ledger-write-data-split

一、必读上下文
1. AGENTS.md（目录树铁律、文件归属与 R2–R4 不变量）
2. docs/VERIFY.md
3. docs/handoff/GOAL-3B-TOB-R1-LEDGER-WRITE-DATA-SPLIT-20261124.md 中 <Wxx> 节与第 3 节红线
4. changes/tob-agent-workspace/技术方案.md 对应章节

二、本切片目标、改动范围与测试要求
<粘贴第 4 节中 <Wxx> 全部正文>

三、严格禁区（违反直接打回）
- 严禁执行 git commit / git push / git merge / 切换或新建分支（全部提交由 Orchestrator 统一执行）
- 严禁启动 bun run dev / docker compose up / e2e/scripts/run-e2e-tests.sh
- 严禁修改 Wxx 范围外文件，严禁提前实现 Goal #3C MIG-E/F 收紧或 Goal #4 R2 Agent 工具
- 严禁删减业务断言、加硬编码 sleep、加 test.skip，或修改 ESLint / VERIFY 门禁规则
- 若改动后端 DTO：必须执行 bun run --cwd clients/chat-web generate:api；前端零影子 DTO、零裸 useEffect、零定时器

四、交付与自测要求
1. 编码完成后执行对应 check:structure / lint / typecheck / 切片测试（确保新增用例支持 -t 独立运行，不漏孤儿组织）
2. 最终回复只列：① 修改/新增文件列表 ② 核心逻辑与 路径:行号 ③ 自测命令与实际通过条数 ④ 残留风险（如有）。
```

**模板 2：只读对抗性审查派单模板（发给异构对抗审引擎）**

```text
【任务】FXplannerREBUILD · Goal #3B · <Wxx 切片> 独立对抗性审查（严格只读，禁止修改任何文件）
工作目录：/Users/kyle/Documents/工作/知爻/FXplannerREBUILD
待审对象：当前工作区针对 <Wxx> 的未提交 diff（相对当前分支 HEAD）及新增测试实测情况

一、裁判隔离原则
- 请从 origin/dev 基线读取 AGENTS.md、eslint.config.mjs、docs/VERIFY.md 作为唯一裁判标准。
- 严格只读：禁止修改任何代码、禁止执行写操作或 git commit / push。

二、强制对抗核查清单（逐项寻找漏洞与反例）
1. 范围与目录合规：是否越界修改 Wxx 外文件或提前触发 Goal #3C/Goal #4？路径是否完全符合 AGENTS.md？
2. 租户与权限安全：写接口是否挂 OrganizationContextGuard + PermissionGuard？锁内是否经 lockOrganizationForActor 重读最新角色？有无 userId 旁路或跨组织存在性泄露（必须 404）？
3. 事务与审计原子性：所有业务写与 AuditService.recordInTx 是否在同一 Prisma 事务内？审计失败是否整单回滚？detail 是否走 sanitizeAuditDetail？
4. 金额与 FIFO 精度：金额/汇率/占比/CSV 导出是否全用 Decimal，无原生 Number() 浮点混入？UTC+8 日界与同日 FIFO 排序是否完整保留？
5. 契约与静态护栏：改 DTO 后 generate:api 是否双跑零 diff？前端是否有裸 useEffect / 定时器 / 跨层逆向引用？
6. 测试防愚弄：新增测试能否单用例 -t 独立通过、测后是否零孤儿组织、并发竞争是否用 postgres-lock-barrier 确定性断言、有无 skip/sleep/同义反复 mock？

三、强制输出格式
- 按三态标签逐条分级：[Important]（必改阻断）/ [Nit]（非阻断建议）/ [Pre-existing]（存量不阻断）
- 每条必须写明：① 编号 ② 精确 路径:行号 ③ 源码/diff 证据摘句或竞态/越权复现路径 ④ 最小修复建议
- 末尾给出汇总结论：各标签计数 + 是否满足「0 [Important] 准入提交」。
```

---

## 3. 分支、自治、架构不变量与作用域红线（违反即打回）

- **Git 自治边界**：仅在 `feat/tob-r1-b-ledger-write-data-split` 内按切片 W22–W28 小步 Conventional Commit（由 **Orchestrator 唯一执行**，尾部附 `Verified: ...` 与对抗审结论），最终由 Orchestrator push 特性分支并创建 1 个 **Draft PR** → `dev`。**严禁** push/merge `dev`/`main`，**严禁**转 Ready。
- **服务禁令**：Orchestrator 与两款桌面端均**严禁**启动 `dev` / `docker compose up` / `e2e/scripts/run-e2e-tests.sh`；L3 E2E 仅编写或更新用例并交由人类启服验收。
- **Goal #3A 确立的不可退化不变量（必须延续）**：
  1. **锁内重读操作者**：凡在组织级写锁内判定角色/资格的路径，必须使用 `lockOrganizationForActor` 重读最新 `Membership`，禁止沿用 Guard 放行前的旧 `actor.role`（R2-I01 / R3-N1）。
  2. **同事务审计原子性**：全部业务写与 `AuditService.recordInTx(tx, ...)` 必须在同一 Prisma 事务内提交或回滚（§13.1），detail 走 `sanitizeAuditDetail`；`PermissionGuard` 的 `DENIED` 审计保留 `requestId` 透传，并评估加超时保护防止审计库抖动拖慢 403。
  3. **前端组织作用域纪律**：全部组织数据查询使用 `withOrgScope(orgId, ...)` + `enabled: orgId !== null`；跨模块失效走 `invalidateBusinessKey`；切组织后后续导航用 `mutateAsync().then(...)` 而不依赖已卸载组件的调用点 `onSuccess`（R3-I02）；外部中止流统一调 `abortActiveStream()`；会话重置唯一入口 `clients/chat-web/lib/auth/session-reset.ts`。
  4. **测试卫生与确定性并发**：新增用例必须**单用例独立可运行（支持 `-t` 过滤）**、测后不漏孤儿组织；并发竞争测试必须复用 `services/chat/test/helpers/postgres-lock-barrier.ts`（`runBehindAdvisoryLock` / `raceBehindAdvisoryLock`）做确定性断言，禁止 `sleep` / `skip` / 删断言。
- **严格作用域边界（防大爆炸）**：
  - **禁止提前执行 `MIG-E`/`MIG-F` 破坏性收紧**（`organizationId` 非空收紧、删 `UserSettings` 旧列与删 `User` 级联留给 `Goal #3C`）；
  - **禁止提前实现 ToB R2 组织 Agent 业务工具与计划草稿**（W25 **只做** `AiConversation` 写/读/删全端点绑定 `organizationId` 隔离，工具留给 `Goal #4`）；
  - **静态护栏**：零手写影子 DTO（改 DTO 后必跑 `bun run --cwd clients/chat-web generate:api` 且双跑零 diff）；页面与业务组件零裸 `useEffect` 与定时器。

---

## 4. 原子级垂直切片清单（W22–W28）

### W22（P4-1）：个人/组织设置分离 + 组织独立建账（`LEDGER-02`）+ `OnboardingService` 并发锁
- **编排归属**：主开发 **ZCode** ｜ 对抗审 **MiniMax Code + Orchestrator** ｜ 准入：Step B–D 全过且 `[Important] = 0`
- **目标**：解耦 `UserSettings`（个人 `locale`/`region`）与 `OrganizationSettings`（组织 `baseCurrency`/`prepPreference`/`reminderEnabled`/`ledgerStartedAt`），让多组织用户可为新建的第二个组织独立完成首次建账（关闭 Goal #3A §6.2 遗留），并顺手收口 Goal #2 延后项 ①（`OnboardingService` 组织级账本行锁）。
- **可选顺手结构项（R3-N3）**：评估在本切片或 W26 迁移中为 `organizations` 增加可空 `created_by_id` 并回填，替代未来删除个人工作台时的隐式时间推断（若加列，同步更新 `resolveDefaultOrganizationId` 与 `organization-reconcile.ts` 保持单源）。
- **改动文件**：
  1. `services/chat/src/settings/`（`settings.controller.ts`、`settings.service.ts`、`dto/settings.dto.ts`）：
     - 区分个人偏好（`locale`/`region`，无需 `settings.update` 权限，写 `UserSettings` upsert，兼容无个人设置行的受邀成员）与组织偏好（`prepPreference`/`reminderEnabled`，挂 `OrganizationContextGuard` + `PermissionGuard` + `@RequiresPermission("settings.update")`，写 `OrganizationSettings` + 同事务 `AuditLog`）；
     - 保持 `baseCurrency` 建账后只读锁死无任何更新通道。
  2. `services/chat/src/onboarding/`（`onboarding.controller.ts`、`onboarding.service.ts`、`dto/onboarding.dto.ts`）：
     - `POST /onboarding/complete` 与 `POST /onboarding/initial-holdings` 挂载 `OrganizationContextGuard` + `PermissionGuard` + `@RequiresPermission("settings.update")`（Operator/Viewer 403）；
     - `saveConsents` 保持个人维度（`TermsConsent`）；`complete` 与 `initial-holdings` 在事务内先取组织级账本锁，再写入当前组织的 `OrganizationSettings` 与带 `{ organizationId: actor.organizationId, createdById: actor.userId }` 的 `Account`/`InitialHolding`/`CostLot`（并双写兼容 `userId` 至 Goal #3C），同事务写 `AuditLog`；
     - 多组织用户为未建账 Org B 调用 `complete` 不再被本人 `UserSettings` 阻塞报 409。
  3. 执行 `bun run --cwd clients/chat-web generate:api`。
- **必配测试**：`services/chat/test/api/settings.spec.ts`、`services/chat/test/api/onboarding.spec.ts`、`services/chat/test/integration/onboarding.spec.ts`（Org A 已建账不影响 Org B 独立建账；Viewer/Operator 建账与改组织设置 403；审计写入故障注入导致整单回滚；并发建账/补录锁竞争回归）。
- **Commit**：`feat(ledger-write): migrate settings and onboarding to organization scope with tx audit` — `Verified: unit, api, integration, diff`

---

### W23（P4-2）：交易（`Transaction`）与计划（`Plan`）写接口 Actor 化、组织级并发锁与同事务审计（`LEDGER-01`）
- **编排归属**：主开发 **MiniMax Code** ｜ 对抗审 **ZCode + Orchestrator** ｜ 准入：Step B–D 全过且 `[Important] = 0`
- **目标**：`Transaction` 与 `Plan` 全部写路径切换为接收 `ActorContext`，写入 `organizationId` + `createdById`/`actorUserId`，并精确区分 **`OPERATOR` 可写 Plan、禁写 Transaction**（`AUTH-01`）；顺手收口 Goal #2 延后项 ②（`TransactionService` 纳入组织级 `lockLedgerAccounts`）。
- **改动文件**：
  1. `services/chat/src/prisma/ledger-write-lock.ts`：支持按 `(organizationId, currencyCodes)` 事务级锁定（兼容过渡期双写）。
  2. `services/chat/src/transaction/`：
     - `POST /api/transactions` 挂载 `OrganizationContextGuard` + `PermissionGuard` + `@RequiresPermission("transaction.create")`（Owner/Admin/Finance ✓，Operator/Viewer 403）；
     - 事务内按 `actor.organizationId` 加账本锁，本位币与记账起点取 `resolveOrganizationPreferences`，写入 `Transaction` + `CostLot`（带 `organizationId`、`createdById`）与同事务 `AuditLog`；保留 `assertValidTransactedAt` 校验。
  3. `services/chat/src/plan/`：
     - `POST /api/plans`（`plan.create`）、`PATCH /api/plans/:id` / `POST /api/plans/:id/{complete,cancel}`（`plan.adjust`）挂载 `OrganizationContextGuard` + `PermissionGuard`；
     - 事务内对组织名下 `Account` 与 `Plan` 加锁，全部 `Plan` / `PlanChangeLog` 写入 `organizationId` 与 `createdById`/`actorUserId`，同事务写 `AuditLog`；跨组织 `planId` 写操作统一 404。
  4. 执行 `bun run --cwd clients/chat-web generate:api`。
- **必配测试**：`services/chat/test/api/transaction.spec.ts`、`services/chat/test/api/plan.spec.ts`（`OPERATOR` 建 Plan 201、记 Transaction 403 且写 `DENIED` 审计；`VIEWER` 全写 403；跨组织 Plan 写操作 404；多成员并发写交易与创建分配计划的余额/未分配额/审计数一致）。
- **Commit**：`feat(ledger-write): migrate transaction and plan writes to ActorContext with tx audit` — `Verified: unit, api, integration, diff`

---

### W24（P4-3）：使用记录（`Usage`）、组织级 `USAGE` 更正与共享账本 FIFO 重放（`LEDGER-04`）
- **编排归属**：主开发 **ZCode** ｜ 对抗审 **MiniMax Code + Orchestrator** ｜ 准入：Step B–D 全过且 `[Important] = 0`
- **目标**：`UsageService` 与 `CorrectionService`（覆盖 `TRANSACTION`、`INITIAL_HOLDING`、`USAGE` 三类目标）写路径全面组织化；确保成员 A 买入的批次可被成员 B 的使用记录消费，多人并发更正稳定触发 `baseVersion` 冲突拦截。
- **改动文件**：
  1. `services/chat/src/usage/`：
     - `POST /api/plans/:id/usages` 挂 `OrganizationContextGuard` + `PermissionGuard` + `@RequiresPermission("usage.create")`（Operator/Viewer 403）；
     - 事务内按 `{ id: planId, organizationId }` 查父 Plan 并加锁，加载同组织全量活跃 `CostLot`（跨成员共享 FIFO 池），写入 `UsageRecord`（`organizationId`, `createdById`）与 `UsageLotAllocation`，同事务写 `AuditLog`。
  2. `services/chat/src/correction/`：
     - `POST /api/corrections` 挂 `OrganizationContextGuard` + `PermissionGuard` + `@RequiresPermission("correction.apply")`（Operator/Viewer 403）；
     - 事务内目标加载、账户锁、全链路重放（`CostLot`/`Transaction`/`InitialHolding`/`UsageRecord`/`UsageLotAllocation`/`Plan`/`PlanAllocation`/`Account`）与批次重建全部按 `actor.organizationId` 执行；
     - `Correction` 与补分配 `PlanChangeLog` 写入 `organizationId` 与 `actorUserId`，同事务写 `AuditLog`（`FAILED` 独立留痕同样带 `organizationId` + `actorUserId`）。
  3. 执行 `bun run --cwd clients/chat-web generate:api`。
- **必配测试**：
  - 新增 `services/chat/test/integration/organization-ledger-isolation.spec.ts`（Org A/B 同币种同金额全闭环零串联；同组织 Finance 1 买入 → Finance 2 使用与更正，FIFO 与报告一致）；
  - 扩充 `services/chat/test/integration/correction-replay.spec.ts`、`services/chat/test/api/correction.spec.ts`、`services/chat/test/api/plan-usage.spec.ts`（多人并发 `baseVersion` 冲突、`OPERATOR` 403、审计失败回滚）。
- **Commit**：`feat(ledger-write): migrate usage, correction, and FIFO replay to shared organization ledger` — `Verified: unit, api, integration`

---

### W25（P4-4）：成员级提醒已读（`ReminderRead`）、报告与 `AiConversation` 全端点组织绑定（`LEDGER-03`, `AGENT-01`）
- **编排归属**：主开发 **MiniMax Code** ｜ 对抗审 **ZCode + Orchestrator** ｜ 准入：Step B–D 全过且 `[Important] = 0`
- **目标**：彻底关闭 Goal #3A §6.3（受邀成员标已读 404 / 行主覆写共享 `readAt`）与 §6.4（AI 会话未按组织写入与隔离）两处兼容遗留。
- **改动文件**：
  1. `services/chat/src/reminder/`：
     - `POST /api/reminders/:id/read` 与 `POST /api/reminders/read-all` 挂 `OrganizationContextGuard` + `PermissionGuard` + `@RequiresPermission("plan.read")`；
     - 校验提醒属于当前组织后，仅 upsert 当前 `actor.userId` 的 `ReminderRead(reminderId, userId, readAt)`，**严禁**修改共享 `Reminder.readAt`；被移除（`DISABLED`）成员立即 404。
  2. `services/chat/src/report/`：核实全汇总/成本查询零 `userId` 旁路，必要时补齐创建者/操作者展示字段并走 `generate:api`。
  3. `services/chat/src/ai/`：
     - `POST /ai/conversations`、`POST /ai/conversations/:id/messages`、`DELETE /ai/conversations/:id` 全部挂载 `OrganizationContextGuard` + `PermissionGuard` + `@RequiresPermission("agent.use")`；
     - 新建会话写入 `{ userId: actor.userId, organizationId: actor.organizationId }`；所有列表/消息/追问/删除严格按 `{ id, userId: actor.userId, organizationId: actor.organizationId }` 校验（移除 `ai.service.ts` 对 `organizationId IS NULL` 的跨组织放行，改按默认组织受控回落或要求已回填）；
     - 工具清单保持现有公共汇率能力，**不提前加入 R2 企业工具**。
  4. 执行 `bun run --cwd clients/chat-web generate:api`。
- **必配测试**：`services/chat/test/api/reminder.spec.ts`、`services/chat/test/integration/reminder-plan-lifecycle.spec.ts`（同组织 A/B 各自已读互不影响；受邀成员标已读 200；跨组织 404）；`services/chat/test/api/ai-chat.spec.ts`（U1 在 Org A 建会话，带 Org B 头访问/追问/删除均 404；移出 Org A 后 404）。
- **Commit**：`feat(reminder,report,ai): write member-scoped ReminderRead and bind all AiConversation endpoints to organization` — `Verified: api, integration, diff`

---

### W26（P5-1）：`DataRequest` 双域拆分、`CHECK` 约束、最后 Owner 保护与 CSV 精度修复（`DATA-01`）
- **编排归属**：主开发 **ZCode** ｜ 对抗审 **MiniMax Code + Orchestrator** ｜ 准入：Step B–D 全过且 `[Important] = 0`
- **目标**：彻底解耦个人数据权利与组织数据权利，消除个人注销误删共享企业账本风险（关闭 Goal #3A §6.5/§6.6 遗留），并顺手收口 Goal #2 延后项 ③④（`07-plan-allocations.csv` 精度与 `executeCleanup` 原子条件认领）。
- **改动文件**：
  1. Prisma 迁移 `<ts>_tob_r1_data_request_scope_check`：为 `data_requests` 添加 `CHECK` 约束：
     `(scope = 'PERSONAL' AND type IN ('EXPORT', 'DELETION') AND organization_id IS NULL) OR (scope = 'ORGANIZATION' AND type IN ('EXPORT', 'CLEAR', 'DELETION') AND organization_id IS NOT NULL)`。
  2. `services/chat/src/data-request/data-request-rules.ts`（及 `.spec.ts`）：`scope × type` 合法性矩阵、锁语义、最后 Owner 阻塞判定、审计清理策略。
  3. `services/chat/src/data-request/data-request.service.ts`、`export-builder.ts`、`dto/data-request.dto.ts`：
     - `PERSONAL EXPORT`（仅个人资料/偏好/组织摘要/个人会话元数据，不含组织财务明细，不锁写）；
     - `PERSONAL DELETION`：检查用户是否为任一组织唯一 `ACTIVE OWNER` → 是则返回 **`409 LAST_OWNER_REQUIRED` + 阻塞组织列表**；通过后仅清个人身份与个人数据，**绝不级联删除所属组织账本**；
     - `ORGANIZATION EXPORT`（`data.export` + OTP，导当前组织账本与报告，修复 `07-plan-allocations.csv` Decimal 精度）；
     - `ORGANIZATION CLEAR`（`data.clear` + OTP，7 日冷静期可撤回，到期清空当前组织业务表并重置 `OrganizationSettings.ledgerStartedAt = null`，同事务写 `AuditLog`，不影响其他组织）；
     - `ORGANIZATION DELETION`（`organization.delete` 仅 Owner + OTP，到期显式事务清理当前组织派生表，不删任何成员 `User`）；
     - `executeCleanup` 改用条件原子 `updateMany({ where: { id, status: { in: ["PENDING", "FAILED"] } }, data: { status: "PROCESSING" } })`。
- **必配测试**：`data-request-rules.spec.ts`、`export-builder.spec.ts`（含 `07-plan-allocations.csv` 精度断言）、并发原子认领单测、DB `CHECK` 约束 `services/chat/test/prisma.spec.ts`。
- **Commit**：`feat(data-request): split PERSONAL/ORGANIZATION scopes, add DB CHECK, last-Owner guard, and CSV precision fix` — `Verified: unit, infra, diff`

---

### W27（P5-2）：双锁守卫拆分（`PersonalAccountLockGuard` + `OrganizationLockGuard`）与下载实时重验（`DATA-02`, §9.3）
- **编排归属**：主开发 **MiniMax Code** ｜ 对抗审 **ZCode + Orchestrator** ｜ 准入：Step B–D 全过且 `[Important] = 0`
- **目标**：拆分单一全局 `DataRequestLockGuard` 为个人锁与组织锁，严格保持 **单请求至多 1 条锁查询 + DB 异常 fail-closed (500) + 白名单读时推进** 不变量。
- **改动文件**：
  1. `PersonalAccountLockGuard`：查 `userId` 名下 `scope = 'PERSONAL'` 进行中 `DELETION` 请求（`403 ACCOUNT_PENDING_DELETION`），不锁同组织其他成员；物理删除 `User` 时调用 `RequestAuthService.invalidateRequestUser(request)` 返回 `401`。
  2. `OrganizationLockGuard`（置于 `OrganizationContextGuard` 之后、`PermissionGuard` 之前，§4.3）：查 `actor.organizationId` 名下 `scope = 'ORGANIZATION'` 活跃 `CLEAR`/`DELETION` 请求（`403 ORGANIZATION_DATA_LOCKED`），不影响同一用户在其他组织的操作；白名单（进度/撤回/下载）仍必须先过 `OrganizationContextGuard` + 权限校验（成员被移除或降权后原导出下载链接立即失效，`DATA-02.5`）。
  3. 控制器拆分个人与组织数据请求端点，完善 Swagger DTO 并执行 `bun run --cwd clients/chat-web generate:api`。
- **必配测试**：`services/chat/test/integration/organization-data-lifecycle.spec.ts` & `services/chat/test/api/data-request.spec.ts`（个人注销不锁他成员、Org A 锁不影响 Org B、成员降权/禁用后导出下载 403/404、最后 Owner 个人注销 409 → 转移/删组后成功、Prisma SQL 计数断言与 DB 异常 fail-closed）。
- **Commit**：`feat(data-request): split PersonalAccountLockGuard and OrganizationLockGuard with download re-auth` — `Verified: unit, api, integration, diff`

---

### W28（P4/P5-3）：前端权限感知交互、双域数据中心页与兼容收口
- **编排归属**：主开发 **ZCode** ｜ 对抗审 **MiniMax Code + Orchestrator** ｜ 准入：Step B–D 全过且 `[Important] = 0`
- **目标**：将 W22–W27 能力落地前端（零影子 DTO、零裸 `useEffect`、零定时器、严禁把前端 `capabilities` 当唯一防线）。
- **改动文件**：
  1. `clients/chat-web/lib/api/`：按最新 `schema.gen.ts` 更新 `settings.ts`、`data-requests.ts`、`query-keys.ts`（拆分个人 data-requests 与 `withOrgScope(orgId, ...)` 组织 data-requests 键，确保 `invalidateAfterDataRequestMutation` 按域精准失效）。
  2. `clients/chat-web/lib/hooks/`：新增 `use-organization-capabilities.ts`；更新 `use-data-request.ts`、`use-reminders.ts`（对未建账/组织锁零无效 409/403）。
  3. `clients/chat-web/components/business/settings/`：拆分「个人展示偏好（`locale`/`region`）」与「组织设置（本位币只读、准备偏好、提醒开关）」，无 `settings.update` 权限角色对组织设置只读。
  4. `clients/chat-web/components/business/{plan,transaction,usage,correction,account-data,organization}/` 与对应受保护页：
     - 按 `capabilities` 控制记一笔（`transaction.create`）、使用/更正（`usage.create` / `correction.apply`）、建计划（`plan.create`）按钮显隐或明确只读提示；
     - `/data-requests` 拆分为「当前组织数据权利（导出/清空/删除）」与「个人账号数据权利（个人导出/注销）」两个独立面板；遇 `409 LAST_OWNER_REQUIRED` 展示阻塞组织列表与直达成员页入口；
     - `client.ts` / `chat.ts` 分别处理 `403 ORGANIZATION_DATA_LOCKED` 与 `403 ACCOUNT_PENDING_DELETION`；
     - 顺手补齐 `OrganizationPicker` 的退出登录入口（关闭 Goal #3A §9.6 体验 backlog）。
- **验证**：`bun run test web`、`bun run lint && bun run typecheck`、`PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run build`。
- **Commit**：`feat(web): add capability-aware ledger actions and split personal/organization data-request UI` — `Verified: unit, web, diff`

---

## 5. 全量验证门禁与整枝终审对抗审（W28 提交后、创建 Draft PR 前必过）

1. **Diff 触发检查**：`git diff --name-only dev...HEAD`，对照 `docs/VERIFY.md` §2 核对 Prisma `CHECK` 约束、全业务 Controller 权限与锁链、FIFO 重放、`export-builder` 精度、`generate:api` 双跑零 diff。
2. **L1 + L2 + `build` 全跑**：
   - `bun run check:structure && bun run lint && bun run typecheck`
   - `PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run test unit web scripts money dev-log`
   - `bun run db:status && bun run test api integration infra`
   - `PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" bun run build`
   - 核对本地库 `plan_allocations` / `usage_lot_allocations` 孤儿为 `0`，且本轮测试不新增无成员孤儿组织。
3. **整枝终审对抗审（D6）**：由 Orchestrator（`carbon`）结合异构桌面端对 `dev...HEAD`（W22–W28 全量合集）做最终跨切片集成审查，确认 W22–W28 台账全部具备独立对抗审闭环记录，且重点复核：
   - 全部写事务与 `AuditLog` 严格同事务失败同回滚（无「账已改但审计丢」）；
   - Service 零 `userId` 绕过组织查询或裸 ID 越权写；
   - 多人并发买入/计划分配/使用/更正无竞态，锁内重读操作者角色；
   - `PERSONAL DELETION` 零级联删组织账本 + 最后 Owner 双重拦截；
   - 组织导出链接在成员降权/禁用后立即拒绝（403/404）；
   - 双锁守卫无活动请求时单次查询上限与 DB 异常 fail-closed (500)。
   - 全部 `[Important]` 必须清零后复跑受影响套件。

---

## 6. 提交、交接与 Goal #3C 准入门输出

- `.changeset/tob-r1-b-ledger-write-data-split.md`
- 由 Orchestrator push `feat/tob-r1-b-ledger-write-data-split` → 创建 **Draft PR** 到 `dev`（严禁 merge / ready）
- 生成 `docs/handoff/OVERNIGHT-TOB-R1-B-YYYYMMDD.md`，必须包含：
  1. **Orchestrator 双引擎编排与对抗审台账**：每切片（W22–W28）的 `主开发引擎 / 对抗审引擎 / 对抗审轮次 / [Important] 清零与修复摘要 / Commit SHA / L1·L2 实测计数 / Computer Use 掉线或降级披露`；
  2. 并发锁/审计/FIFO/双域数据请求测试计数与 SQL 计数证据、`07-plan-allocations.csv` 修复证据、整枝对抗审终审闭环记录；
  3. 待人类启动服务后运行的 E2E 回归清单（含受影响原有模块与新增双域/多成员 E2E 用例）；
  4. **`Goal #3C` 执行 `MIG-C→F` 约束收紧与去 `User` 级联的前置核对项**。
