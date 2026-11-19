# Goal #0 — FXplannerREBUILD · PR #1 工作区收口微任务

> 适用阶段：Phase 0 前置收口（不改任何业务代码）
> 目标环境：Antigravity `/goal`（独立对抗审优先 Codex CLI，不可用时降级为 Antigravity 独立只读审查 Agent 并在 handoff 披露）
> 依据决策：`docs/ITERATION-REFACTOR-ROADMAP-20261119.md` §1（D2、D4、D5、D7）与 `AGENTS.md`

---

## 1. 背景与唯一上下文（开工必读）
- 仓库：`/Users/kyle/Documents/工作/知爻/FXplannerREBUILD`
- 当前分支：`feat/iteration-a-mvp-closeout`（对应 draft PR #1 → `dev`）
- 目标：在不引入任何业务功能改动的前提下，把工作区当前未提交的规范文档、ToB 设计资产、原型修改与运行产物彻底收口干净，固化 D4/D5 决策结论并纠偏过时的 ✅ 进度表，使 draft PR #1 达到可人工审查合并的状态。
- 必读文件：
  - `AGENTS.md`
  - `docs/VERIFY.md`
  - `docs/ITERATION-REFACTOR-ROADMAP-20261119.md`
  - `docs/handoff/DISCLAIMER-CANDIDATES-20261105.md`
  - `docs/handoff/MIMOSA-GATE-20261105.md`

## 2. 分支与安全边界（红线，违反即失败）
- 仅允许在当前分支 `feat/iteration-a-mvp-closeout` 提交并 push 更新 draft PR #1。
- **严禁**合并 PR #1、**严禁**将 draft PR #1 转为 ready、**严禁**推向 `dev`/`main`、**严禁**修改业务源码（`services/chat/src/**`、`clients/chat-web/app/**`、`clients/chat-web/components/**`、`packages/money/src/**`）、**严禁**启动长驻 `dev` 或 `docker compose up` 服务。
- **严禁**提交任何 `.env.local` 或真实密钥；**严禁**新增安全门禁旁路脚本进仓。

## 3. 必做任务清单（按序执行，主题拆 commit）

### 任务 1：纠偏进度真相与固化免责决策（D5）
1. **免责声明终选落档（D5）**：人类已拍板采用 **A 版（代码现状默认，70 字）**，不修改 `clients/chat-web/components/base/compliance-disclaimer.tsx`；更新 `docs/handoff/DISCLAIMER-CANDIDATES-20261105.md` 与 `changes/mvp-completion/审查报告-20261103.md` §2 中「待选定」表述为「已选定 A 版（2026-11-19）」。
2. **USAGE 更正文档纠偏（消除假绿）**：实测 `services/chat/src/correction/correction.service.ts:1080-1085` 仍拒绝 `USAGE` 且 `e2e/modules/11-correction.spec.ts:249` `T-CORR-004` 为 `test.skip`。将 `README.md:15` 与 `changes/mvp-completion/审查报告-20261103.md:32` 的「修改使用记录 / 使用更正」改标为 **🟡 降级待修（归入 MVP-F0-3）**，写明待 `Goal #1` 跑通后再恢复 ✅。

### 任务 2：工作区产物清理与未提交改动主题拆包
1. 检查 `git status -s`：
   - 清理或移除不该入库的运行产物：`test-results/`、`e2e/test-results/`、`services/chat/logs/dev.log`、`services/chat/data-exports/*.zip`；对于 `docs/handoff/zcode-ui/*.png` 截图，核对 `.gitignore` 或交接必要性后按既有约定处理（`docs/handoff/OVERNIGHT-ZCODE-20261105.md:69` 注明 UI 截图不入库，清理或纳入忽略规则，勿遗留未跟踪噪声）。
2. 将工作区既有合法未提交资产按主题拆分为清晰 commit（每个 commit 附 `Verified:` 戳记）：
   - Commit A（工程规范与工作流）：`AGENTS.md`、`CLAUDE.md`、`docs/VERIFY.md`、`docs/ITERATION-REFACTOR-ROADMAP-20261119.md`、`docs/VIBE-CODING-PLAYBOOK.md`、`docs/handoff/PR1-BEHAVIOR-ASSERTIONS-20261105.md`、`docs/handoff/GOAL-*.md`；
   - Commit B（ToB 规划文档，标注待评审/未实施）：`changes/tob-agent-workspace/`；
   - Commit C（交互原型更新）：`docs/MVP功能模块&业务逻辑&专业术语/FXplanner-V2.5-MVP用户交互原型.pen`；
   - Commit D（D5 定稿与进度表纠偏）：`README.md`、`changes/mvp-completion/审查报告-20261103.md`、`docs/handoff/DISCLAIMER-CANDIDATES-20261105.md`。

### 任务 3：Mimosa 门禁按 D4 核验直提
1. 按 D4 核验本地 Mimosa 门禁状态：保留 Write/Edit 写入前扫描，确保 `git-gate` 已降级为告警或卸载，在常规 `git commit` 下可正常直提而不再依赖 `` `git -C "$PWD"` `` 旁路；若环境限制仍不可直提，按 `docs/handoff/MIMOSA-GATE-20261105.md` 与 `docs/VERIFY.md` §3 留痕原因与对应命令行状态。

## 4. 验证与交付
1. 静态检查与工作区校验：
   - `bun run typecheck`（必须 0 error）
   - `git status -s` 确认无未跟踪运行产物或意外脏文件
   - `git diff origin/dev...HEAD --stat` 核对无误触业务源码
2. 独立对抗审（优先 Codex CLI；不可用时降级为 Antigravity 独立只读审查 Agent 并披露）：核对本次全部文档/规范/原型提交无路径格式错误、无误删内容、无虚假 ✅ 勾选。
3. 推送 `feat/iteration-a-mvp-closeout` 更新 draft PR #1（禁止 merge / 禁止转 ready），生成交接报告 `docs/handoff/OVERNIGHT-PR1-CLOSEOUT-20261119.md`，提示人类审查合并 PR #1 后即可启动 `Goal #1`。
