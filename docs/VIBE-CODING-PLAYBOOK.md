# FXplannerREBUILD Vibe Coding 最佳实践手册

> 适用范围：FXplannerREBUILD 全仓日常开发、架构重构与长程夜间执行。
> 核心共识：以 **Antigravity** 为主阵地（`/grill-me` → `/plan` → `/goal` / `/teamwork`），以 **`docs/VERIFY.md`** 与 **异构独立对抗审** 防止单模型同源盲区与假绿。

---

## 1. 已接入工具矩阵与职责边界

| 阶段 | 已接入工具 / 仓库资产 | 职责定位（各司其职，不越界） |
| --- | --- | --- |
| **需求消歧 & 原型** | `/grill-me`、`.pi/skills/dev-steps/discuss/SKILL.md`、`pencil` MCP（`.pen` 原型）、`figma` MCP | 在写代码前压出业务边界、金融口径与「不做清单」；交互核对直接读 `docs/MVP功能模块&业务逻辑&专业术语/FXplanner-V2.5-MVP用户交互原型.pen` |
| **规划 & 架构拆分** | `/plan`（Plan/Execute 双模型协议）、`.pi/skills/dev-steps/plan/SKILL.md`、`bun run docs:codemap` | 强模型只读核查真代码，定死文件路径、DTO/Schema、Diff 触发项与测试矩阵，再交执行模型落地 |
| **长程 & 并行实施** | `/goal`、`/teamwork`（`swarm` + `run_workflow`）、`bun run worktree:create` | 单目标端到端闭环用 `/goal`；多独立模块并行用 `worktree` 隔离 + `swarm` 分片 |
| **契约 & 本地观测** | `bun run --cwd clients/chat-web generate:api`、`packages/dev-log-server/`、`bun run db:up` / `db:status` | 后端 DTO 为唯一共享类型来源；前端运行时异常通过 `@sentry/browser` 落盘 `packages/dev-log-server/logs/` 供 AI 定位 |
| **分层验证 & 巡检** | `docs/VERIFY.md`、`scripts/test.ts`、`bun run test:e2e`、`/browser`、`chrome-devtools` skills | 廉价检查先行 → 单元/`fast-check` 属性/差分 → API/集成 → Playwright E2E + 浏览器 UI 走查 |
| **独立对抗审** | 外部异构 CLI（优先 Codex CLI）；降级时使用 Antigravity 独立只读审查 Agent；`.pi/workflows/template-review.js` | 打破「写代码与验代码同一模型」的盲区，强制输出三态标签 |
| **门禁、提交与沉淀** | `.husky/`（`lint-staged` + `commitlint`）、`bun run commit`、`bun run changeset`、Mimosa（Write/Edit 扫描）、`/learn`、`/compact`、`.pi/skills/dev-steps/archive/SKILL.md` | 规范留痕；把重复踩坑固化成类型/lint/属性测试/E2E，而不是无限堆 `AGENTS.md` |

---

## 2. 六步标准作业闭环（日常 & `/goal` 通用）

### Step 1 · Spec 与用户可观察行为断言先行（10–20 分钟）

1. 新功能或跨模块重构开干前，先跑 `/grill-me`（或按 `.pi/skills/dev-steps/discuss/SKILL.md`）逐分支收敛边界问题，**严禁带着模糊假设写代码**。
2. 涉及界面或流程变化时，用 `pencil` MCP 检查 `docs/MVP功能模块&业务逻辑&专业术语/FXplanner-V2.5-MVP用户交互原型.pen`。
3. 产物锁定在 `changes/<feature>/需求文档.md`（或既定迭代清单），**只抓两件事**：
   - **明确范围与非目标**（本批做什么、明确不做什么）；
   - **3–6 条用户可观察行为断言**（参照 `docs/handoff/PR1-BEHAVIOR-ASSERTIONS-20261105.md`），从源头拒绝「只测内部 mock」的同义反复测试。

### Step 2 · 强模型只读规划 + 测试设计绑定

1. 切入 `/plan`，强制规划阶段**只读核验代码事实**（如 `services/chat/src/correction/correction.service.ts:1080-1085`、实际 `schema.prisma`），**不轻信旧文档的 ✅ 勾选**。
2. 方案落盘 `changes/<feature>/技术方案.md`（或接力 Goal 文档），必须包含：
   - 精确文件改动清单（新增模块/包先对照 `AGENTS.md` 目录树与文件归属规则，必要时先更新 `AGENTS.md` 再编码）；
   - 完整测试设计：**单元 + `fast-check` 属性测试（金融/汇率/纯函数必配）+ 差分测试（旧逻辑迁移必配）+ API + 集成 + E2E**；
   - 明确的 **Re-plan 触发条件** 与退出标准。
3. 若拆分多模块并行（如 ToB R1 的只读端与成员管理端），先用 `bun run worktree:create` 创建独立工作树，再用 `/teamwork` 分派。

### Step 3 · 小步垂直切片 Vibe Build

每个切片控制在「1 个可独立测试的闭环」，严格按以下顺序落地：

1. **Schema / Migration**：先核对数据库已有约束与 relation（如 `plan_change_logs` 已有数据库 FK，避免重复迁移冲突），生成 migration；
2. **后端 DTO + 契约生成**：完成 Controller/DTO 后立即运行 `bun run --cwd clients/chat-web generate:api`，**严禁在前端手写影子类型**；
3. **纯函数内核 + 属性测试**：金额、汇率、舍入、分摊计算一律放纯函数层（跨端放 `packages/money/`），同步写 `fast-check` 属性测试（Round-trip / Invariants / Idempotency / Equivalence）；
4. **业务 Service + API / 集成测试**：一个 Controller 对应一个 `services/chat/test/api/<模块>.spec.ts`，一个业务流对应一个 `services/chat/test/integration/<流>.spec.ts`；
5. **前端 hooks + 业务组件**：hooks 单测放 `clients/chat-web/lib/hooks/*.spec.ts(x)`；组件严格遵守单向依赖 `business → base → ui`，业务组件必带 `index.ts` 桶文件。

**开发期纪律**：
- **由人类启动服务**：`bun run dev`、`docker compose up` 和会自动起服的 `e2e/scripts/run-e2e-tests.sh` 均由人类执行。
- **前端排错优先看日志**：查阅 `packages/dev-log-server/logs/` 与 Chrome DevTools，不盲猜；
- **3 轮自愈熔断**：同一测试或构建报错连续自动修复 **3 轮**仍未通过，立即停机保存现场并向人类汇报，禁止死循环硬凑。

### Step 4 · 分层确定性验证

按 `docs/VERIFY.md` 执行。已安装本地 `verify` 技能时，可用它辅助执行相同步骤。

严格按**由廉价到昂贵**跑完四关，前一关不绿不进入下一关：

1. **Diff 触发检查**：跑 `git diff --name-only <base>...HEAD`，逐项核对 `docs/VERIFY.md` §2：
   - 改 `packages/money/**` 或汇率/金额计算 → 必有 `fast-check` 属性测试；
   - 改 `services/chat/src/**` DTO → 已跑 `generate:api` 且无手写影子类型；
   - 改 `clients/chat-web/app/page.tsx`、首页或报告页 → 合规免责声明（A 版常量）与金额格式（`` `$200 USD` ``，货币代码在后）可见；
   - 改 `services/chat/test/**` 或 `e2e/**` → `env-first` 夹具 + 同函数回环校验 `localFetch`；
   - 改 `services/chat/prisma/**` 或 `correction/` → 验证迁移、幂等与审计轨迹。
2. **L1（秒级）**：`bun run typecheck && bun run lint && bun run test unit web scripts money dev-log`。
3. **L2（十秒级）**：`bun run db:status` 确认数据库就绪后执行 `bun run test api integration infra`。
4. **L3（分钟级，确认人类已启动服务）**：
   - 先用 `bun run test:e2e --grep "<TAG>"` 跑受影响用例，收口前用 `bun run test:e2e` 跑全量。
   - 视觉与交互走查可配合 `/browser`；
   - **Flaky 铁律**：严禁删有效断言、加硬编码 `sleep`、盲目放大 timeout 或加 `skip`；
   - **产物清理规程**：查看报告/截图留档后、提交前执行 `rm -rf e2e/test-results`，避免污染安全门禁。

### Step 5 · 异构独立对抗审

1. **优先调用外部异构模型 CLI（如 Codex CLI）**做全量 `git diff` 独立审查；若当前环境不可用或无额度，降级为 **Antigravity 独立只读审查 Agent**，并在 handoff 中显式披露降级原因。
2. **裁判隔离**：审查规则与门禁配置一律从 `dev` / `main` 基线分支读取，被审改动不得修改裁判标准。
3. **三态标签强制分级**：
   - **`[Important]`**：阻断项，必须全部修复并重跑受影响测试直到 0 failed；
   - **`[Nit]`**：非阻断建议，按性价比选择处理或记账；
   - **`[Pre-existing]`**：存量问题，记录进交接文档 backlog，不阻断当前 PR。
4. **FXplanner 固定 5 项高危加审面**：
   - 金额/成本/占比计算是否混入原生 `Number()` 浮点运算（应使用 `Decimal` / 定点）；
   - 多源汇率方向是否统一为「1 外币 = X 本位币」，以及日级源时间窗口是否正确；
   - UTC+8 日界划分与同日 FIFO 排序是否被截断破坏；
   - 多租户（ToB 阶段）查询/派生表/导出/SSE/缓存 key 是否全部绑定 `organizationId` 且跨租户返回 404；
   - 测试中是否潜伏 `test.skip`、仅测 mock 的同义反复断言或与代码矛盾的虚假 ✅ 文档。

### Step 6 · 规范交付、自治边界与经验反哺

1. **自治边界（严格遵守 D7）**：
   - ✅ **允许**：在特性分支内自主小步 commit、安装方案写明的 devDependency（如 `fast-check`）、push 特性分支到远端并创建/更新 **draft PR**；
   - ⛔ **禁止**：合并进 `dev`/`main`、将 draft PR 转为 ready、直接 push 到 `dev`/`main`、执行任何生产部署或改服务器/域名配置。
2. **安全门禁与提交规范**：
   - Mimosa 配置按 D4 执行：**保留 Write/Edit 写入前扫描**，将 `git-gate` 降级为告警或卸载以恢复正常直提；若仍遇结构性规则冲突，严格按 `docs/VERIFY.md` §3 与 `docs/handoff/MIMOSA-GATE-20261105.md` 留痕披露；
   - 使用 Conventional Commits（`bun run commit`）与 `bun run changeset`，提交正文尾部附验证戳记：
     `Verified: <unit|property|api|e2e|diff|none (reason)>`
3. **交接与经验沉淀**：
   - 每次 `/goal` 或阶段收口产出 `docs/handoff/OVERNIGHT-YYYYMMDD.md`（写明分支、commit、实测通过数、Diff 触发核对、对抗审闭环与受限边界）；
   - 阶段结束后运行 `/learn` 或 `.pi/skills/log/extract-rules/SKILL.md` + `.pi/skills/dev-steps/archive/SKILL.md`，坚持 **「优先沉淀为类型 / lint / 属性测试 / E2E，其次才写入 `AGENTS.md`」**；
   - 长对话适时执行 `/compact` 压缩上下文，防止注意力退化。

---

## 3. 三种场景起手式速查

| 场景 | 推荐起手流程 |
| --- | --- |
| **日常单点修复 / 小需求** | `/grill-me`（5 分钟对齐）→ `/plan` 写方案 → 垂直切片编码 → `/verify` 逻辑分层跑测 → 独立对抗审 → 特性分支小步 commit |
| **夜间无人值守 / 阶段硬门** | 直接打开 `docs/handoff/GOAL-*.md`，输入 `/goal` 粘贴全文运行 → 次日审阅 `docs/handoff/OVERNIGHT-*.md` 与 draft PR → 人工合并 |
| **大型跨端功能（如 ToB R1）** | `/grill-me` 锁产品取舍 → `/plan` 拆可并行模块 → `bun run worktree:create` → `/teamwork` 分派前后端/测试 → 按 `docs/VERIFY.md` 汇总验证与独立对抗审 |
