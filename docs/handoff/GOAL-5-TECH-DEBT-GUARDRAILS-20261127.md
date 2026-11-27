# Goal #5 交接与验收报告 — 工程债清零与门禁升级（`feat/tech-debt-guardrails`）

**日期**: 2026-11-27
**分支**: `feat/tech-debt-guardrails`（堆叠于 Draft PR #13 `origin/feat/tob-r2-agent` `20d03ca` 之上，在隔离 worktree `Worktrees/tech-debt-guardrails` 执行）
**目标**: 清零 Goal #2 / Goal #3B / Goal #3C / Goal #4 遗留的技术债与前后端门禁缺口，并将全仓静态门禁从观察期（`observe`）升级为全量零警告硬拦截（`enforce`）。

---

## 一、已关闭的工程债与安全硬化清单

### 1. 数据权利请求发起人标识与 UI 双重门控（`N4` / W28-C）
- **后端契约 (`services/chat/src/data-request/`)**：
  - `DataRequestViewDto` 新增 `@ApiProperty({ type: Boolean }) isRequester!: boolean`（`requesterUserId !== null && requesterUserId === viewerUserId`），向有权成员准确标识当前视图是否由本人发起，同时保持零 `requesterUserId` 隐私暴露（已删除用户的历史请求 `requesterUserId = null` 恒得 `false`）。
  - `DataRequestService.getOrganizationCurrentView` / `toView` 全调用点补全 `viewerUserId`（含 `create` 的 `409 DATA_REQUEST_CONFLICT` 响应）。
  - 执行两次 `bun run --cwd clients/chat-web generate:api`，`openapi.json` 与 `schema.gen.ts` SHA-256 完全一致（`c36fdd74...` / `6f6fcc1f...`）。
- **前端消费 (`clients/chat-web/components/business/account-data/`)**：
  - `RequestProgress` 与 `ExportDownloadButton` 在 `scope=ORGANIZATION` 时以「角色能力 ∧ `view.isRequester`」双重门控撤回/下载按钮；具备角色权限但非发起人本人时展示 `organization-request-non-requester-hint` 说明，不再引导用户点击必然 404 的按钮；Viewer 无权成员只见进度不触发误导提示。
  - 新增单元测试 `clients/chat-web/components/business/account-data/request-progress.spec.tsx`（4 cases）。

### 2. 前端写入口能力门控补全（`P1` / `OVERNIGHT-TOB-R1-B`）
- `clients/chat-web/app/(protected)/accounts/page.tsx`：页眉与空态「录入换汇」链接接入 `can("transaction.create")` 门控；新增 `page.spec.tsx`（2 cases）。
- `clients/chat-web/components/business/account/account-ledger-table.tsx`：初始持仓行「更正」链接（`initial-correction-entry`）接入 `can("correction.apply")` 门控（保留只读「查看买入详情」）；新增 `account-ledger-table.spec.tsx`（2 cases）。
- `clients/chat-web/components/business/report/report-plan-list.tsx`：空态「去创建计划」链接（`reports-empty-create`）接入 `can("plan.create")` 门控；新增 `report-plan-list.spec.tsx`（2 cases）。

### 3. ToB R2 Agent 组织工具先鉴权后验参（Goal #4 `D6` Nit #2）
- `services/chat/src/ai/tools/{account-summary-tool,plan-exposure-tool,plan-cost-tool,upcoming-actions-tool,draft-plan-tool}.ts`：
  - 全部业务入参校验下沉至 `guard({ ..., run: async (freshActor) => ... })` 内部，确保被移除/禁用/锁定/无权调用者在传非法参数时同样先触发实时 `tool-guard` 拦截并落盘 `AuditLog(DENIED)`，而非前置返回 `INVALID_*_PARAMS`。
  - `draft_fx_plan` 对负数、`NaN`、`Infinity` 或空串 `allocatedAmount` 明确返回 `INVALID_PLAN_PARAMS`（`plan_draft_blocked`）且不触发 `onDraft`（不再静默钳制为 `"0.0000"`）。
  - 扩展 `services/chat/src/ai/tools/agent-tools.spec.ts` 覆盖上述先鉴权与负值拦截不变量。

### 4. 业务组件 `useEffect` 白名单清零与全仓 ESLint `--enforce` 升级（`P7`）
- **移除全部 5 个业务组件豁免**：`eslint.config.mjs` 的 `LEGACY_USE_EFFECT_FILES` 从 13 个文件缩减至 8 个（仅剩页面级与打印延时组件）：
  - `preferences-form.tsx`：本已零 `useEffect`，直接移出；
  - `message-list.tsx` → 抽取受控 DOM hook `clients/chat-web/hooks/use-auto-scroll-to-bottom.ts`；
  - `model-selector.tsx` → 白名单自愈收敛至 `useModelSelection()`（`clients/chat-web/lib/hooks/use-models.ts`）；
  - `wizard-step-holdings.tsx` → 改本位币联动下沉至 `onboarding/page.tsx` 事件回调 + `useMemo` 派生清理，零 `useEffect`；
  - `plan-adjust-dialog.tsx` → 弹窗生命周期、回调 ref 与焦点定位收敛至 `usePlanAdjustDialog()`（`clients/chat-web/lib/hooks/use-plan-adjust.ts`），顺带消除了该文件原有的两处 `react-hooks/exhaustive-deps` 抑制注释。
- **全仓 ESLint Warning 清零**：
  - 清理 `clients/chat-web` 全部 17 条 warning（`exhaustive-deps`、`no-non-null-assertion`）。
  - 清理 `services/chat` 全部 61 条 warning（含 `correction.service.ts` `LoadedTarget` 改造成判别联合 + `mustGet` 不变量收窄、`auth.service.ts` 消除 `any`、`data-request` / `onboarding` / `rate*` / `ai-agent` 消除 `!`）。
- **门禁脚本升级**：
  - `scripts/lint-observe.ts` 新增 `--enforce` 参数（全包扫描文件 0 error & 0 warning 强制阻断），并收紧分支差异策略使 `modified` 与 `added` 文件同样零警告阻断；同步更新 `scripts/__tests__/lint-observe.spec.ts`。
  - `clients/chat-web/package.json` 与 `services/chat/package.json` 的 `lint` 脚本均切换为 `--enforce`。

---

## 二、验证结果（全部实测通过，0 failed）

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 静态门禁与 `--enforce` | `bun run lint` | 通过：`check:structure` ✅、`check:org-scope`（68 文件 0 违规）✅、`clients/chat-web` **0 errors, 0 warnings（267 文件）** ✅、`services/chat` **0 errors, 0 warnings（283 文件）** ✅ |
| 负向 `--stdin` 拦截双证 | `eslint --config eslint.config.mjs --stdin` × 5 + `--max-warnings=0 --stdin` × 2 | 7/7 全部精确拦截（5 个移出白名单组件均拦截裸写 `useEffect`；前后端 `--max-warnings=0` 均拦截 `!`） |
| 全仓类型检查 | `bun run typecheck` | 通过（6 个 workspace 包全部 PASS） |
| 后端单元（含属性测试） | `bun run test unit` | 通过：51 files，753 passed（1 既有 todo） |
| 前端单元 | `bun run test web` | 通过：40 files，452 passed |
| 精度纯函数包（含 `fast-check`） | `bun run test money` | 通过：4 files，64 passed |
| 开发日志包 | `bun run test dev-log` | 通过：4 files，31 passed |
| 工程脚本对照与门禁单测 | `bun run test scripts` | 通过：3 files，24 passed |
| 后端 API 接口测试（含 409 矩阵） | `bun run test api` | 通过：22 files，851 passed |
| 后端集成测试 | `bun run test integration` | 通过：19 files，152 passed |
| 数据库基础设施与约束 | `bun run test infra` | 通过：1 file，27 passed |
| 生产构建 | `bun run build` | 通过：`@fxplanner-new/chat` + `@fxplanner-new/chat-web` build 成功 |
| Playwright E2E 清单发现 | `bunx playwright test --list` | 通过：112 tests in 21 files |
| 全量浏览器 E2E（L3） | `./e2e/scripts/run-e2e-tests.sh` | 通过：**112 passed, 0 failed, 0 skipped, 0 flaky**（耗时 919.1s） |
