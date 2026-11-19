# Goal #1 — FXplannerREBUILD · MVP-F0 正确性闭环与验证护栏加固

> 适用阶段：Phase 0 护栏补齐 + Phase 1（MVP-F0 正确性硬门）
> 前置门控：**必须在 PR #1 已合入 `dev` 后启动**（从最新干净 `dev` 切出新特性分支）
> 依据决策：`docs/ITERATION-REFACTOR-ROADMAP-20261119.md`（D1–D9）、`docs/VIBE-CODING-PLAYBOOK.md`、`changes/tob-agent-workspace/技术方案.md` §15.1、`docs/VERIFY.md`、`AGENTS.md`
> 汇率切片实施底稿：`changes/realtime-rate/MVP-F0-汇率回补与缓存迁移计划-20261119.md`，包含外部覆盖实测、清理与回滚顺序和 FX-01 至 FX-07 验收。

---

## 1. 背景与唯一上下文（开工必先只读核验）
- 仓库：`/Users/kyle/Documents/工作/知爻/FXplannerREBUILD`
- 前置校验（**开工第一步**）：
  1. 检查 `git status -s`、`git fetch origin` 与 `dev` 分支是否已包含 PR #1 收口提交（如 `docs/ITERATION-REFACTOR-ROADMAP-20261119.md`、Goal #0 提交）；
  2. 若当前工作区存在未清理冲突，或 PR #1 尚未合入 `dev`，**立即停机并向人类汇报阻塞原因**，禁止在陈旧基线上强行开工；
  3. 确认 `dev` 干净且已同步后，切出新特性分支：`feat/mvp-f0-correctness-and-guardrails`。
- 必读基线文件：
  - `AGENTS.md`
  - `docs/VERIFY.md`
  - `docs/ITERATION-REFACTOR-ROADMAP-20261119.md`
  - `docs/VIBE-CODING-PLAYBOOK.md`
  - `changes/tob-agent-workspace/技术方案.md` §1.1、§11（DEBT-01/02）、§15.1（MVP-F0）
  - `docs/handoff/OVERNIGHT-ZCODE-20261103.md`（注意 B1 同日 FIFO 排序历史教训）

## 2. 分支、自治与安全红线（违反即失败）
- **Git 自治边界（D7）**：允许在特性分支 `feat/mvp-f0-correctness-and-guardrails` 内自主小步 commit、安装本 Goal 写明的 devDependency（`fast-check`）、push 该特性分支到远端并创建 **draft PR**（目标 `dev`）。
- **严禁操作**：禁止 merge 到 `dev`/`main`、禁止将 draft PR 转为 ready、禁止直接 push 到 `dev`/`main`、禁止执行生产部署或更改服务器/域名配置、禁止提交 `.env.local` 或真实密钥。
- **服务禁令**：由人类启动前后端服务。AI 确认服务就绪后直接运行 Playwright，取证后清理 `e2e/test-results`。`e2e/scripts/run-e2e-tests.sh` 会自行起服，留给人类执行。
- **门禁规范（D4）**：保持 Mimosa Write/Edit 写入前扫描，使用常规 `git commit` 直提（若 `git-gate` 仍阻断测试基建，按 `docs/VERIFY.md` §3 与 `docs/handoff/MIMOSA-GATE-20261105.md` 留痕披露，禁止新增旁路脚本进仓）。
- **3 轮自愈熔断 & Flaky 零容忍**：同一报错连续修复 **3 轮**仍败必须立即停机保存现场并汇报人类；严禁删减业务断言、加硬编码 `sleep`、盲目放大 timeout 或加 `skip`。

---

## 3. 必做任务清单（垂直切片，每切片小步 commit）

### 任务 A：验证护栏与规范对齐（Phase 0 收尾）
1. 在 `packages/money/package.json` 的 `devDependencies` 安装 `fast-check`，并补齐属性测试：
   - `packages/money/src/round.property.spec.ts`
   - `packages/money/src/calc.property.spec.ts`
   - 至少覆盖：往返守恒（Round-trip）、精度不退化为 IEEE-754 浮点漂移、非负与分拆守恒（Invariants）、重复归一化幂等性（Idempotency）、JPY/KRW 0 位小数与极端汇率边界。
2. 更新 `scripts/test.ts` 与 `.github/workflows/ci.yml`：
   - 新增 `money`（`packages/money`）与 `dev-log`（`packages/dev-log-server`）测试套件并纳入 `bun run test all` 与 CI `test` job，消除全量测试漏跑。
3. 补齐 `packages/dev-log-server/README.md`（写清：做什么职责 / 不做什么边界 / 为何独立成包）。
4. 对齐 `AGENTS.md` 中 `services/chat/src/` 目录树与真实代码结构（体现实际 15 个业务模块 + `config`/`prisma` 共 17 个子目录，移除已不存在的 `project`/`database` 占位，不删改其他无关章节）。

### 任务 B：跨源汇率方向统一与历史脏汇率清洗（MVP-F0-1）
1. 冻结系统唯一汇率方向口径：**1 外币（`quote`）= X 本位币（`base`）**（与 `services/chat/src/rate/rate-source.abc.ts:43,198-201` 一致）。
2. 修复 `services/chat/src/rate/rate-source.erapi.ts` 的 latest 与 `services/chat/src/rate/rate-source.frankfurter.ts` 的 latest/history。ErApi 无密钥接口保留本地历史路径：
   - 将上游返回的 `1 base = raw quote` 精确取倒数为 `1 quote = X base`；
   - 使用定点运算或 `Decimal` + 约定小数位舍入，**严禁使用原生浮点 `1 / Number(raw)`**。
3. 排查所有下游消费方（`onboarding`、`transaction`、`report`、`market`、AI 汇率工具、`e2e/scripts/run-e2e-tests.sh:91` 的 `RATE_SOURCE=frankfurter` 路径），确认无双重取倒数或 mock/断言方向错乱。
4. 缓存处理在方向和日级规则就绪后演练。先盘点、停旧写并保全快照，再原位转换方向可证的 ErApi 行，最后转换或受控替换 Frankfurter 旧行。附迁移清单、复跑计数、覆盖对账和回滚记录。依据为实施底稿 §3。
5. **验收测试**：新增 ABC / ErApi / Frankfurter 三源同币对等价单测 + `fast-check` 倒数往返与高精度属性测试；确认 `rate` 相关单测/API/E2E 全绿。

### 任务 C：日级报价时效与原时点回补修复（MVP-F0-2）
1. 首次建账及补录走 `getLatest`，按系统确认的 `fresh/validUntil` 校验，保留真实来源时间。初始持仓币种更正走 `findQuoteAt`，以 `original.confirmedAt` 区分实时窗口与有证据的日级回看。
2. TWD 图表缺口使用 Frankfurter v2 日级参考序列。参考点与 `exchange_rates` 和原时点入账候选隔离；只有日期的序列无法证明当时可用时，保留 `RATE_QUOTE_UNAVAILABLE`。
3. **验收测试**覆盖 00:05、14:30、23:55 UTC+8 的建账与原时点更正，分别断言最新报价时效、历史来源、未来点排除、冷缺口拒绝和无部分业务写入。另验 7/30/90/365 天图表与多源 E2E。依据为实施底稿 §2、§4。

### 任务 D：USAGE 更正完整闭环 + 共享 FIFO 纯函数内核（MVP-F0-3 / DEBT-01 & DEBT-02）
1. 从 `services/chat/src/correction/ledger-replay.ts` 与 `services/chat/src/usage/usage-calculator.ts` 抽取单一共享 FIFO 消耗纯函数内核，消除双实现算法漂移；用既有 FIFO 镜像测试与 15 类计算用例回归验证零差异。
2. 移除 `services/chat/src/correction/correction.service.ts:1080-1085` 的 `USAGE` 挡板，完整实现 `USAGE` 更正闭环：
   - 目标加载（`UsageRecord` + 关联 `Plan`）与 `baseVersion` 乐观锁并发校验；
   - 改小、改大、改日期的影响预览（含分配上限/缺口校验）与提交持久化口径 100% 一致；
   - `UsageRecord`、`PlanAllocation`、`CostLot`/`UsageLotAllocation` 与更正前后快照同事务重放，失败零副作用；
   - **同日 FIFO 排序保护**：严守 `OVERNIGHT-ZCODE-20261103.md` 披露的 B1 教训，使用记录与买入记录同日内必须保留真实时间/录入顺序，不得截断到日 0 点导致误报资金不足。
3. 取消 `e2e/modules/11-correction.spec.ts:249` `T-CORR-004` 的 `test.skip`，补齐真实端到端断言并跑通；同步扩充 API 测试与集成测试 `services/chat/test/integration/correction-replay.spec.ts`。
4. 仅在全部单测、API、集成与 `T-CORR-004` E2E 均为 0 failed 后，更新 `changes/mvp-completion/审查报告-20261103.md` 与 `README.md` 对应的 USAGE 更正验收证据。

### 任务 E：生产导出目录权限 + CSV 本位币精度修复（MVP-F0-4）
1. 修复 `infra/compose/Dockerfile.chat`（对照 `infra/compose/compose.prod.yaml:47-49` 的 `DATA_EXPORT_DIR: /data/exports` 与 `fxplanner-exports:/data/exports` 挂载）：
   - 在切换到 `USER bun` 前创建 `/data/exports` 与 `/app/services/chat/data-exports` 并执行 `chown -R bun:bun /data/exports /app/services/chat/data-exports`。
2. 修复 `services/chat/src/data-request/export-builder.ts`：
   - 第 `368-369` 行：`principalAmount` 与 `feeAmount`（本位币）改用本位币 `data.settings?.baseCurrency ?? "CNY"` 格式化，禁止误用外币 `row.currencyCode`；
   - 第 `238-246` 行：`usageCostOf` 由 `Number()` 原生累加改为 `Decimal` 累加。
3. **验收测试**：
   - 新增 JPY/KRW 买入交易配 CNY 本位币的 CSV 导出精度单测（验证外币 `quantity` 0 位小数、本位币 `principalAmount` 与 `feeAmount` 2 位小数、未知费用导出「未知」、多批次 `usageCostOf` 无浮点尾差）；
   - 若本机 Docker daemon 可用，构建并按 `USER bun` 启动容器实测写入 `/data/exports`；若 Docker 未运行或受限，在交接文档如实标注检查边界，不编造运行结论。

---

## 4. 验证门禁与独立对抗审（必须真实执行并留日志）

按 `docs/VERIFY.md` 由廉价到昂贵推进：
1. **Diff 触发核查**：执行 `git diff --name-only origin/dev...HEAD`，逐项核对 `docs/VERIFY.md` §2 命中项；若改动任何后端 DTO，必须运行 `bun run --cwd clients/chat-web generate:api` 且确认无手写影子类型。
2. **L1 静态检查与单元/属性测试**：
   - `bun run typecheck`
   - `bun run lint`
   - `bun run test unit web scripts money dev-log`
3. **L2 接口与集成测试**（先 `bun run db:status` 确认本地 Postgres 就绪）：
   - `bun run test api integration infra`
4. **L3 Playwright E2E**（确认人类已启动服务）：
   - `bun run test:e2e --grep "T-CORR|T-USAGE|T-PLAN-LC|T-DATA|T-RATE|T-MARKET|T-ONBOARD"`
   - 受影响用例通过后，执行全量 `bun run test:e2e`。
   - 取证后提交前执行 `rm -rf e2e/test-results`。
5. **异构独立对抗审（D6）**：
   - 优先调用外部异构 CLI（如 Codex CLI）对本批全量 diff 进行独立只读审查；若外部 CLI 不可用，降级为 Antigravity 独立只读审查 Agent，并在交接文档中显式披露；
   - 审查规则从 `dev` 基线读取，强制标注 **`[Important]` / `[Nit]` / `[Pre-existing]`**；
   - 重点加审：Decimal vs `Number()`、跨源汇率方向、日级时间戳不伪造、同日 FIFO 顺序、无 `test.skip`；
   - 所有 `[Important]` 必须全部修复并重跑受影响测试直到 0 failed，不得留存未闭环 `[Important]`。

## 5. 提交与交接产出
- 按切片做 Conventional Commits（`bun run commit` 口径），每个 commit 尾部附 `Verified: <unit|property|api|e2e|diff|none (reason)>`；新增 `.changeset/*.md` 变更记录。
- push `feat/mvp-f0-correctness-and-guardrails` 并创建 **draft PR** → `dev`（严禁转 ready / merge）。
- 生成交接报告 `docs/handoff/OVERNIGHT-MVP-F0-YYYYMMDD.md`，必须包含：
  1. 分支名、draft PR 链接、Commit 清单与任务 A–E 改动文件明细；
  2. L1/L2/L3 实跑命令与通过计数（0 failed 证据摘要）+ Diff 触发清单逐项核对；
  3. 独立对抗审方式（Codex CLI 或降级说明）与 `[Important]`/`[Nit]`/`[Pre-existing]` 闭环清单；
  4. 受限环境边界（如 Docker 实测状态）与给人类审查合并后启动 `Goal #2` 的确认项。
