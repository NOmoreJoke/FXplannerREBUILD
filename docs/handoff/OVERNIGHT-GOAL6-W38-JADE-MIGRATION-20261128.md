# Goal #6 (`W38`) Overnight Handoff：Stage 0b Jade 四类语义迁移与 ESLint 原始色阶禁令

- **目标文档**：[GOAL-6-STAGE0-HARNESS-FOUNDATION-20261127.md](./GOAL-6-STAGE0-HARNESS-FOUNDATION-20261127.md)
- **分支与隔离 Worktree**：`feat/stage0b-jade-semantic-migration`（`/Users/kyle/Documents/工作/知爻/Worktrees/stage0b-jade-semantic-migration`，切自 `dev@6d22d87`）→ **Draft PR → `dev`**

---

## 1. 交付内容

1. **全仓 59 个前端文件四类语义迁移（清零 `mint-*` / `cream-*` / `lilac-*` 及未定义 `mint-200/400/600`）**：
   - **类别 ① 写账本确认动作与已入账事实**（`bg-commit` / `hover:bg-commit-hover` / `text-commit` / `border-commit` / `bg-commit-subtle` / `border-fact` / `border-l-fact`）：
     - 严格限定 `bg-commit` 仅用于真正写入账本的 7 处确认提交按钮（建账/补录初始持仓 `wizard-step-holdings.tsx`、创建计划 `plans/new/page.tsx`、确认修改/重开 `plan-adjust-dialog.tsx`、确认完成 `plans/[id]/page.tsx`、录入买入 `transactions/new/page.tsx`、确认记录使用 `usage-record-dialog.tsx`、确认更正 `corrections/new/page.tsx`）；
     - 已入账 `ACTIVE` / `READY` / `USED_UP` / `APPLIED` / `COMPLETED` / `SUCCESS` 状态徽章与实况条迁移为 `border-commit bg-commit-subtle text-commit` 与 `border-fact border-l-fact`。
   - **类别 ② 非事实与常规操作**（`ink-*` / `bg-neutral-note` / `border-neutral-note` / `border-proposal` / `bg-surface-paper`）：
     - 左导航选中态、对话列表选中态、用户聊天气泡、筛选胶囊与常规主操作（导航/重试/预览/登录注册/组织设置）统一为深墨黑 `bg-ink-900`；
     - 未入账 `PlanDraftCard` 与 `/plans/new` 草稿复核横幅迁移为 `border-proposal bg-surface-paper`；
     - 唯一 `lilac-*` 使用点（`request-progress.tsx` 进行中状态徽标）与 `ComplianceDisclaimer` 容器迁移为 `border-neutral-note bg-neutral-note`（70 字免责原文零改动）。
   - **类别 ③ 品牌标识**（`bg-brand` / `from-brand-subtle`）：仅用于 `FX` 方块 Logo（`app/page.tsx`、`(protected)/layout.tsx`、`login-form.tsx`、`register-form.tsx`）与落地页顶部渐变。
   - **类别 ④ 提醒横幅与注意信号**（`bg-caution` / `border-caution` / `text-caution` / `border-caution-rule` / `bg-caution-rule`）：焦点计划横幅、今日提醒、未读提醒卡片及未定义圆点 `bg-mint-600` → `bg-caution-rule`、手续费未知提示、`PREPARING` 资金缺口、更正冲突与报错说明统一迁移。
2. **清理 `@theme` 过渡保留色阶（`clients/chat-web/app/globals.css`）**：
   - 删除 `--color-lilac-*`、`--color-mint-*`、`--color-cream-*`、`--color-water-*` 过渡定义，仅保留 `ink-*`、`jade-*` 底层色阶与语义 Token / `@utility` 工具类。
3. **新增 ESLint 原始色阶禁令（`eslint.config.mjs`）**：
   - 新增 `NO_RAW_PALETTE_TOKEN_RULE`，在 `clients/chat-web/{app,components}/**/*.{ts,tsx}`（排除 `components/ui/**`）硬拦截任何 `mint-* / cream-* / jade-* / lilac-*` 直写，并在 Flat Config 的 3 层 `no-restricted-syntax` 块中逐层自包含，避免 `LEGACY_USE_EFFECT_FILES` 与打印组件被规则覆盖旁路。

---

## 2. 独立审查与双证门禁实测

- **独立对抗审查**（依据 `ITERATION-REFACTOR-ROADMAP-20261119.md` D6：`codex review` 报 `gpt-6.2-sol` 模型受 ChatGPT 账号目录限制 400 不可用，降级为 Antigravity 独立只读 `research` subagent 审查）：
  - 初审结果：**`[Important]` = 0**，`[Nit]` = 2，`[Pre-existing]` = 1；
  - 已修复 `[Nit]` #1（`home-dashboard.tsx:103` 汇率监控状态圆点由 `bg-commit` 改为 `bg-ink-500`）并全套复验通过。
- **全仓零残留扫描**（修复后复跑）：
  - `rg -n "(mint|cream|lilac|jade|water)-" clients/chat-web/{app,components,hooks,lib} -g '!**/globals.css'` → **0 命中**；
  - `rg -n "(mint-|cream-|lilac-|water-)" clients/chat-web/app/globals.css` → **0 命中**。
- **正/负向 ESLint `--stdin` 双证**：
  - 正向全量：`bun run lint` 通过（`check:structure` ✅、`check:org-scope` 68 文件 0 违规 ✅、`clients/chat-web` **0 errors, 0 warnings / 267 文件** ✅、`services/chat` **0 errors, 0 warnings / 283 文件** ✅）；合法语义类 `bg-commit bg-ink-900 bg-caution bg-brand` `--stdin` 退出 `0`；
  - 负向拦截：`eslint --config eslint.config.mjs --stdin` 实测拦截 `bg-mint-700`、`bg-cream-100`、`text-jade-700`、`bg-lilac-50`、模板字符串 `` `${a ? "bg-jade-50" : ""}` ``、`LEGACY_USE_EFFECT_FILES` 中的 `plans/new/page.tsx` 与 `plan-report-print-view.tsx`，并保留 `useEffect` 与 `setTimeout` 既有拦截（全部退出码 `1`）。
- **L1 全套 & 构建实测**（最后一次编辑后全量重跑，0 failed）：
  - `bun run typecheck`：4/4 包 PASS；
  - `bun run test unit web scripts money dev-log`：`unit` 51 files / 753 passed (1 todo)、`web` 40 files / 452 passed、`money` 4 files / 64 passed、`dev-log` 4 files / 31 passed、`scripts` 3 files / 24 passed；
  - `bun run build`：`@fxplanner-new/chat` + `@fxplanner-new/chat-web`（21 路由）构建成功。
