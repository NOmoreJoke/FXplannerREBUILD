# W37 Review Remediation & Audit Record (`I-1`–`I-4`)

> **Date**: 2026-11-28  
> **Branch**: `fix/stage0a-review-remediation` (based on `dev@6d22d87`)  
> **Remediates**: `dev` commits `1110257`, `ecf7c86`, `6d22d87` (`W37`, Stage 0a)  
> **Related Open Draft PRs**: PR #16 (`W38`, `feat/stage0b-jade-semantic-migration`), PR #17 (`W39`, `feat/stage0c-compliance-copy-gate`)

---

## 1. Review Findings Addressed

1. **`I-1` (`AGENTS.md` 目标态误写成现状 + 缺乏静态目录真源门禁)**:
   - Reverted `AGENTS.md` lines `34, 59, 60, 104, 147` (plus removed nonexistent `与分期验收记录` on line `107`) so `AGENTS.md` strictly reflects paths existing on `dev`: removed premature registrations for `services/chat/src/proposal/`, `services/chat/src/ai/agents/`, `services/chat/src/ai/compliance/`, `clients/chat-web/components/business/collab/`, `clients/chat-web/lib/hooks/use-debounced-proposal-preview.ts`, and `scripts/check-compliance-copy.ts`. Restored `ai/`'s real description (`按 userId+organizationId 隔离会话、配额、公共汇率与组织只读/计划草稿工具、工具级实时鉴权与审计`) while keeping `design-harness/`, `changes/product-harness-agent/`, and `clients/chat-web/public/fonts/` (+ `OFL.txt`).
   - Upgraded `scripts/check-structure.ts` (per Global Rule #3 & registered at `AGENTS.md:181`) to deterministically verify:
     1. Every concrete entry in the `AGENTS.md` directory tree exists on disk (bidirectional module parity for `services/chat/src/*` and `packages/*`), except two `[Pre-existing]` scaffold placeholders (`clients/chat-web/app/(protected)/projects` and `scripts/init`) and `e2e/test-results*` (gitignored);
     2. Every backticked repo-root path (`clients/`, `services/`, `packages/`, `scripts/`, `e2e/`, `design-harness/`, `changes/`, `docs/`, `infra/`) in `AGENTS.md` resolves to an existing path;
     3. Self-hosted font directories under `clients/*/public/fonts/` include a valid `OFL.txt` / `LICENSE*` with copyright notice and verified SHA-256 digest (when declared).
   - Added `scripts/__tests__/check-structure.spec.ts` (positive repo pass + 3 negative violation proofs for `I-1` / `I-2`).
   - Future PRs (starting with `W39` PR #17) must register their newly introduced paths inside the same PR that creates them.

2. **`I-2` (`Playfair Display` 缺少 SIL OFL 1.1 许可证与出处说明)**:
   - Added `clients/chat-web/public/fonts/OFL.txt` containing the 3-line provenance header (`@fontsource-variable/playfair-display`, version `5.0.20 - 5.2.5`, `SHA-256: cb8cac32d5cef83e7674916378c2f47bdbba7e6e6bd936f8026a58ac4e71fa53`), upstream copyright notice (`Copyright 2017 The Playfair Display Project Authors`), and full verbatim SIL Open Font License Version 1.1 text.
   - Enforced automatically by `scripts/check-structure.ts` (`[字体许可证红线]`).

3. **`I-3` (`W37` 绕过退出标准：直推 `dev`、缺全套 L1+build 证据与独立审查记录)**:
   - Documented `W37` closeout violation and remediation here via isolated worktree (`fix/stage0a-review-remediation`) and Draft PR → `dev` (never direct push to `dev`).
   - Re-ran non-cached L1, all 5 unit/script test suites, and non-cached `turbo run build --force` (details below) with independent read-only review prior to Draft PR creation.

4. **`I-4`（「0ms 稳定渲染」只在苹果平台成立，跨平台中文字体退化未记录/未收口)**:
   - Clarified in `design-harness/foundations/typography.md`, `design-harness/intelligence/memories/2026-11-27-zhihe-trust-first.md`, `design-harness/components/patterns/proposal-surface.md`, `clients/chat-web/app/globals.css`, and `clients/chat-web/app/layout.tsx`:
     - Self-hosted `Playfair Display` `.woff2` (`400–900` variable) covers Latin glyphs only; CJK serif relies on OS fonts as a deliberate Mainland China trade-off to eliminate external render-blocking Google Fonts timeouts/FOUT.
     - Added `"Source Han Serif SC"` to `--font-song`, `--font-display`, and `layout.tsx` `fallback`, alongside `"Songti SC"`, `"STSong"`, `"Noto Serif CJK SC"`, `"SimSun"`, `serif`.
     - Recorded cross-platform CJK behavior & Stage 1 guardrails: macOS/iOS renders `Songti SC`/`STSong`; Windows falls back to single-weight (`400`) `SimSun`, so upcoming Chinese `ProposalSurface` `h1`/`h2` titles (Stage 1 `W43`) MUST use `font-medium` (`500`) or `font-synthesis-weight: none` instead of `font-semibold`/`font-bold` to avoid ugly synthetic bold; Android & WeChat WebView degrade gracefully to system CJK sans-serif via generic `serif`; macOS Playwright E2E cannot see Windows/Android fallback behavior without manual fallback inspection.

---

## 2. Verification Evidence (Non-Cached Execution)

Executed in worktree `stage0a-review-remediation` (`fix/stage0a-review-remediation`):

| Check | Command | Result |
| :--- | :--- | :--- |
| Lint + Structure + Org Scope + Observe | `bun run lint` | Exit `0`: ESLint pass, `check:structure` pass, `check:org-scope` 68 files `0` violations, `lint-observe --enforce` `0 error, 0 warning` (`chat-web` 267 files, `chat` 283 files) |
| Typecheck (non-cached) | `bunx turbo run typecheck --force` | Exit `0`: `4/4` packages, `0 cached` |
| Unit / Web / Money / Dev-log / Scripts | `bun run test unit web scripts money dev-log` | Exit `0`: `unit` 51 files (753 pass, 1 pre-existing todo), `web` 40 files (452 pass), `money` 4 files (64 pass), `dev-log` 4 files (31 pass), `scripts` 4 files (28 pass, 0 fail, `102 expect()`) |
| Build (non-cached) + font asset | `bunx turbo run build --force` | Exit `0`: `2/2` packages, `0 cached`; verified `clients/chat-web/.next/static/media/playfair_display_latin_wght_normal-s.p.0t-srnnjqsd1l.woff2` (38,372 bytes) |
| Negative CLI Proof (`--stdin-agents-md`) | `printf '...\n└─ proposal/\n' \| bun scripts/check-structure.ts --stdin-agents-md` | Exit `1`: rejected non-existent `services/chat/src/proposal` with `[AGENTS.md 真源红线]` |
| Font SHA-256 Digest | `shasum -a 256 clients/chat-web/public/fonts/playfair-display-latin-wght-normal.woff2` | `cb8cac32d5cef83e7674916378c2f47bdbba7e6e6bd936f8026a58ac4e71fa53` (matches `OFL.txt`) |

### Pre-existing Backlog Notes (`[Pre-existing]`)
- `AGENTS.md:30` lists `clients/chat-web/app/(protected)/projects` and `AGENTS.md:104` lists `scripts/init` (both present since initial skeleton commit `97fd8aafd`); explicitly quarantined in `scripts/check-structure.ts` (`LEGACY_DOC_ONLY_TREE_PATHS` / `LEGACY_DOC_ONLY_SCRIPT_TOKENS`) pending human confirmation before removal.
- Root workspace Note (`dev@6d22d87`) previously had pre-existing W38 raw-palette items only inside PR #16's scope; untouched here (`globals.css` changes are strictly confined to lines 10–12).
