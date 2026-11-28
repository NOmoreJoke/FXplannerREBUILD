# Goal #6 (`W39`) Overnight Handoff：Stage 0c 同源合规封杀词库与静态文案门禁

- **目标文档**：[GOAL-6-STAGE0-HARNESS-FOUNDATION-20261127.md](./GOAL-6-STAGE0-HARNESS-FOUNDATION-20261127.md)
- **分支与隔离 Worktree**：`feat/stage0c-compliance-copy-gate`（`/Users/kyle/Documents/工作/知爻/Worktrees/stage0c-compliance-copy-gate`，基于 `fix/stage0a-review-remediation` / PR #18）→ **Draft PR #17 → `dev`**（随本 PR 在 `AGENTS.md` 同步登记 `services/chat/src/ai/compliance/` 与 `scripts/check-compliance-copy.ts`，建议合入顺序：PR #18 → PR #16 / PR #17）

---

## 1. 交付内容

1. **同源合规封杀词库与纯函数校验器（`services/chat/src/ai/compliance/compliance-lexicon.ts`）**：
   - 零外部依赖纯 TS 模块，供静态 CI 门禁与后续 Stage 1 后端知禾运行时规则校验层共读；
   - 收录四大类封杀词（`INVESTMENT_PROMISE` / `MARKET_PREDICTION` / `TIMING_INDUCEMENT` / `LEGACY_BRAND_OR_BUREAUCRACY`，含 `灵积`、`总控`、`记账专员`、`规划专员`、`审查员`、`圆桌派单`）；
   - `maskAllowedComplianceContexts` 仅将窄化后的法定免责与占位短语替换为等长空格（绝不整行豁免、防左右拼接造词，已移除过宽的裸 `"收益比较"` 与 `"选择时"`）；
   - 运行时 `scanTextForComplianceViolations` 不识别源码注释豁免标记 `compliance-allow`，防止模型输出自注绕过；
   - 同步新增同目录单测 `services/chat/src/ai/compliance/compliance-lexicon.spec.ts`（6 cases）。
2. **静态合规文案门禁脚本（`scripts/check-compliance-copy.ts`）与根 `package.json` 接入**：
   - 基于字符级状态机 `stripCommentsPreservingPositions` 剥离 `//`、`/* ... */` 与 JSX `{/* ... */}` 注释（完整识别单/双引号字符串、嵌套模板字面量 `${...}` 与 JS/TS 正则字面量及 JSX `<tag />` / `</tag>`），保留原行列号且不误伤 `"https://..."` URL 与 `/\/\//` 正则；
   - 行内 `compliance-allow` 仅在出现于本行被剥离注释部分时放行，严防字符串字面量伪造绕过；同步在 `clients/chat-web/components/business/report/plan-cost-summary-card.tsx:215` 为需求 5.4 法定占位标题 `收益比较` 添加单行 `{/* compliance-allow: ... */}`；
   - 新增根脚本 `"check:compliance-copy"` 并串入根 `package.json` 的 `"lint"` 链；
   - 新增工具链单测 `scripts/__tests__/check-compliance-copy.spec.ts`（9 tests）。

---

## 2. 独立审查与双证门禁实测

- **独立对抗审查**（依据 `ITERATION-REFACTOR-ROADMAP-20261119.md` D6：`codex review` 报 `gpt-6.2-sol` 模型受 ChatGPT 账号目录限制 400 不可用，降级为 Antigravity 独立只读 `research` subagent 审查）：
  - 初审指出 3 项 `[Important]`（正则字面量状态机缺失、运行时共享白名单 `"收益比较"` 过宽、漏收 `"审查员"`）与 2 项 `[Nit]`；
  - 已全部修复 3 项 `[Important]` 与 `[Nit]` #4（收窄 `"选择时"` 为 `"已选择时"` / `"未选择时"`），并在 `plan-cost-summary-card.tsx:215` 紧贴占位标题添加单行注释（无多余尾随空格）；
  - 增量复核结论：**`[Important]` = 0**，`[Nit]` = 1（TSX 文本节点未转义英文撇号属 fail-closed 误报，非绕过风险，不阻断），`[Pre-existing]` = 0。
- **正/负向 `--stdin` 双证**：
  - 正向全仓：`bun run lint` 通过（`check:structure` ✅、`check:org-scope` 69 文件 0 违规 ✅、`check:compliance-copy` **387 文件 0 违规** ✅、`clients/chat-web` **0 errors, 0 warnings / 267 文件** ✅、`services/chat` **0 errors, 0 warnings / 285 文件** ✅）；合法输入 `--stdin` 退出码 `0`；
  - 负向拦截：`printf 'export const BAD = "现在抄底稳赚，最佳时机建议买入，审查员";\n' | bun run scripts/check-compliance-copy.ts --stdin --stdin-filename clients/chat-web/app/page.tsx` 返回退出码 `1`，精确拦截全部 6 处命中并输出 `file:line:column [category:term]`。
- **L1 全套 & 构建实测**（0 failed）：
  - `bun run typecheck`：4/4 包 PASS；
  - `bun run test unit web scripts money dev-log`：`unit` 52 files / 759 passed (1 todo，含 `compliance-lexicon.spec.ts` 6/6)、`web` 40 files / 452 passed、`money` 4 files / 64 passed、`dev-log` 4 files / 31 passed、`scripts` 4 files / 33 passed（含 `check-compliance-copy.spec.ts` 9/9）；
  - `bun run build`：`@fxplanner-new/chat` + `@fxplanner-new/chat-web`（21 路由）构建成功。
