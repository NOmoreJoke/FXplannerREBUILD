# Overnight Goal — FXplannerREBUILD · Stage-5 prep (money core + tests + runbook)

> Paste this whole file into Codex CLI Goals / ZCode tonight (Asia/Shanghai).  
> Implementer: **ZCode**. Reviewer after: **MiniMax Code** on the PR/diff.  
> Owner: Kaiming Lu. Do not wait for chat replies; leave a morning handoff file.

---

## 1. Working directory

```text
/Users/kyle/Documents/工作/知爻/FXplannerREBUILD
```

Canonical remote: `NOmoreJoke/FXplannerREBUILD` (private).  
If that path is missing, try `/Users/kyle/Documents/工作/知爻/NOmoreJoke/FXplannerREBUILD` or the clone already open in the IDE — stay inside **one** FXplannerREBUILD tree only.

Stack cue: Bun / Turbo / Next / Nest / Prisma; money domain under `packages/money` (see `AGENTS.md` and `docs/` including `docs/NOMI-FX-ITERATION-AND-BACKLOG-20261103.md` if present).

---

## 2. One concrete MVP slice (tonight only)

**Assumption (box had no local REBUILD tree):** From the 2026-11-03 consolidation/backlog notes, SoT MVP M0–M12 is largely done; **remaining** is stage-5 UI/E2E + compliance + bootstrap. Highest overnight leverage without UI/Figma:

**Harden the core FX planner loop in `packages/money` (and any thin callers it already owns): quote → plan → validate → persist/read-back path; close test gaps; fix bootstrap so a cold clone can run typecheck/tests; add a short local runbook.**

In scope tonight:

1. Read `AGENTS.md`, `packages/money/**`, existing unit tests, and `docs/NOMI-FX-ITERATION-AND-BACKLOG-20261103.md` / `docs/imported-20261103/**` if present. Confirm the real entrypoints (do not invent a second planner).
2. Implement or fix the **smallest** missing pieces so the planner loop is deterministic and covered:
   - Input validation / edge cases (bad pairs, zero/negative amounts, missing rates).
   - Happy-path plan generation with stable, assertable outputs.
   - At least one persistence or repository round-trip **if** the package already has that seam; otherwise stop at pure domain + mocks — do not greenfield a DB layer.
3. Make cold-start bootstrap reliable: `bun install` (frozen if lockfile exists), Prisma generate where required, `bun run typecheck`, targeted `bun test` for money (and any already-wired chat service tests you touch).
4. Add or update `docs/RUNBOOK-LOCAL.md` (or extend README section) with exact commands to install → generate → typecheck → test, plus known env vars that are **placeholders only**.
5. Open a **draft PR** from a feature branch (e.g. `zcode/overnight-money-core-YYYYMMDD`) against the repo default dev branch (`dev` or `develop` — match existing convention). Do **not** merge.

Out of scope tonight: full stage-5 UI, Playwright/E2E against live AI, compliance legal copy, Docker/image pushes, CI YAML rewrites, OntoLearn, Cloud Agent, production deploys.

---

## 3. Acceptance criteria (testable)

- [ ] All changes are confined to FXplannerREBUILD; `git status` shows no other repos.
- [ ] `bun run typecheck` passes from repo root (or document the exact turbo filter that is the project standard — and that filter passes).
- [ ] New or extended unit tests for the planner loop: **≥3** cases covering happy path + ≥2 failure/edge paths; tests run green via the package’s existing test command (prefer `bun test` under `packages/money` or the monorepo script already used in CI).
- [ ] No secrets, real JWT/OTP keys, or production `.env` contents committed or pasted into chat/PR body. CI-style placeholders only.
- [ ] `docs/RUNBOOK-LOCAL.md` (or README “Local run” section) lists copy-paste commands that you yourself ran successfully in this session.
- [ ] Branch pushed; **draft PR** opened with summary + how to verify; PR description links to changed paths.
- [ ] File `docs/handoff/OVERNIGHT-ZCODE-YYYYMMDD.md` exists (create `docs/handoff/` if needed) with: branch name, PR URL, files changed, commands run, known risks, what MiniMax should review first.

---

## 4. Dual-review note (MiniMax)

After ZCode finishes (or at morning):

1. MiniMax Code reviews the **PR diff only** (not a rewrite).
2. Review checklist: correctness of money math / FX assumptions, test realism, bootstrap commands, accidental scope creep, secret leakage, CI cost impact (should be none if workflows untouched).
3. MiniMax leaves review comments or a short `docs/handoff/OVERNIGHT-MINIMAX-REVIEW-YYYYMMDD.md`; ZCode may do one fix-up commit if blockers are clear — still no merge without Kaiming.

Orchestration: Codex Goals may dispatch ZCode then MiniMax; **do not** start Cursor Cloud Agent.

---

## 5. Hard bans

- No push to `main` / production; no merge of the overnight PR without Kaiming.
- No secrets, tokens, private keys, or real `.env` in chat, commits, or PR text.
- No edits outside FXplannerREBUILD; no OntoLearn / GEO / Vibe / unrelated repos.
- No Cursor Cloud Agent; no buying Claude credits as part of this goal.
- No installing GitHub Actions runners; no changing billing; no force-push to shared default branches.
- No “helpful” large refactors, dependency major bumps, or new services.

---

## 6. Morning handoff (what to leave)

Write `docs/handoff/OVERNIGHT-ZCODE-YYYYMMDD.md` including:

| Item | Content |
| --- | --- |
| Branch / PR | names + URLs |
| Files changed | path list |
| Verify | exact commands + pass/fail |
| Residual gaps | what stage-5 UI/E2E/compliance still needs |
| MiniMax | whether review ran + top findings |

Kaiming / Nomi tomorrow: skim handoff → MiniMax review → decide merge vs follow-up ticket.

---

**Start now.** Prefer a small green PR over a sprawling half-done rewrite.
