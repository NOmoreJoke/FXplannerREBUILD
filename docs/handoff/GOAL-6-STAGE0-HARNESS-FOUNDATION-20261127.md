# Goal #6 — Stage 0 设计底座、Jade 语义迁移与同源合规门禁（`W37–W39`）

> **接力序列**：`Goal #5`（`dc30196`） → **`Goal #6 (W37 / W38 / W39)`** → `Goal #7 (Stage 1, W40–W44)`
> **上游真源**：`AGENTS.md`、`docs/VERIFY.md`、`design-harness/README.md`、`changes/product-harness-agent/{需求文档.md,技术方案.md}`

---

## 1. 三切片拆分与并行指引

- **`W37`（Stage 0a · 分支 `feat/stage0a-design-harness-tokens`）**：
  - 更新 `AGENTS.md` 目录树与文件归属表；
  - 落盘 `design-harness/` 四层规范与 `changes/product-harness-agent/{需求文档.md,技术方案.md}`；
  - `clients/chat-web/app/globals.css` & `layout.tsx`：移除早期脚手架残留注释与 Google Fonts 远程 `@import`，接入 `next/font/local` 自托管 `public/fonts/playfair-display-latin-wght-normal.woff2`，注册语义色彩变量与工具类清单。
- **`W38`（Stage 0b · 分支 `feat/stage0b-jade-semantic-migration` · 待 `W37` 合入后可与 `W39` 并行 worktree）**：
  - 用脚本扫描全仓 `mint-*`（57 文件）、`cream-*`（22 文件）、`lilac-*`（1 文件）及未定义类名 `mint-200/400/600`；
  - 按四类语义迁移：①写账本/已入账事实 → `bg-commit / border-l-fact`；②左导航选中态、用户聊天气泡等非事实位置 → `ink-*` 中性色；③Logo 标识 → `bg-brand / text-brand`；④提醒横幅 → `bg-caution / border-caution / text-caution`；完成后从 `@theme` 删除 `mint-*` 与 `lilac-*`；
  - 在 `eslint.config.mjs` 新增业务组件禁用 `mint-* / cream-* / jade-* / lilac-*` 原始色阶规则，完成正向全量 `0 error, 0 warning` 与负向 `--stdin` 拦截双证。
- **`W39`（Stage 0c · 分支 `feat/stage0c-compliance-copy-gate` · 待 `W37` 合入后可与 `W38` 并行 worktree）**：
  - 新增 `services/chat/src/ai/compliance/compliance-lexicon.ts` 同源封杀词与合法语境白名单常量；
  - 新增 `scripts/check-compliance-copy.ts` 并串入根 `package.json` 的 `bun run lint`，编写 `scripts/__tests__/check-compliance-copy.spec.ts` 完成正/负双证。

## 2. 退出标准

1. L1 全绿：`bun run lint && bun run typecheck && bun run test unit web scripts money dev-log && bun run build` 0 failed。
2. 所有新增 ESLint / 门禁脚本均附正向全仓通过 + 负向违规拦截双证记录。
3. 各自独立创建 Draft PR → `dev`（AI 严禁自行启服或自合并）。
