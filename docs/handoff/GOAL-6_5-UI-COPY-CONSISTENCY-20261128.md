# Goal #6.5 交接与验收报告 — 全站中文一致性、控制台报错清零与原型真源收口

- **分支与隔离 Worktree**：`feat/ui-copy-consistency-closeout`（`/Users/kyle/Documents/工作/知爻/Worktrees/ui-copy-consistency-closeout`，切自 `dev@6d894cc`）→ **Draft PR → `dev`**
- **前置审阅基线**：`pre-iteration-full-audit.md`（横跨原始 `/Users/kyle/Documents/工作/知爻/FXplanner`、线上 `https://www.fxplanner.cn/`、`FXplannerREBUILD` 原型/设计底座与当前运行态的四源对账）

---

## 一、已关闭的 7 类一致性与运行态问题

1. **受保护区顶栏面包屑全路由中文化 + 自动扫描守卫（`UI-17`）**
   - `clients/chat-web/components/base/app-breadcrumb.tsx`：补齐 `corrections`（`/corrections/new`→`发起更正`）、`reports`（`我的报告`）、`market`（`汇率行情`）、`chat`（`AI 助手`）、`reminders`（`提醒中心`）、`onboarding`（`首次建账`）、`settings`（`设置`）、`data-requests`（`数据请求进度`）、`projects`（`项目`），保留 `/transactions/new`→`快速录入` 与邀请 token 脱敏契约。
   - `clients/chat-web/components/base/app-breadcrumb.spec.ts`：新增正向递归扫描 `app/(protected)/**/page.tsx` 守卫（覆盖 ≥15 条路由全部含中文且不泄露 token）+ 负向反证（未登记英文路径回退原名）。
2. **更正影响预览中文化（`UI-15`）**
   - `clients/chat-web/components/business/correction/correction-impact-preview.tsx`（及 `index.ts`）：导出 `formatCorrectionFieldLabel` 与 `formatRateSourceLabel`，将 `principalAmount` / `totalCost` / `planId` 等驼峰字段及 `abc` / `er-api` / `frankfurter` 汇率源代号全部映射为中文展示；同步更新 `e2e/modules/11-correction-quote.spec.ts` 断言并新增 `correction-impact-preview.spec.tsx`。
3. **交易详情动态本位币与保留说明修正（`UI-19`）**
   - `clients/chat-web/app/(protected)/transactions/[id]/page.tsx` 与 `clients/chat-web/components/business/transaction/transaction-detail.tsx`：本金/手续费/总成本单位改为读取组织 `baseCurrency`（未就绪时省略后缀，不再写死 `CNY`）；保留说明修改为「单笔更正保留原记录及修改历史，整套数据清理按账号与组织数据规则处理」；新增 `transaction-detail.spec.tsx`。
4. **计划创建中性措辞与排期预览动态批数（`UI-10` / `UI-11`）**
   - `clients/chat-web/components/business/plan/plan-create-form.tsx`：将主动节奏提示由「首批轻仓试探，后续逢低加码」改为合规中性表述「后期多准备：按 20% / 30% / 50% 分批安排（仅调整资金分布，不预测汇率）」，同步更新提前准备天数提示与语义错误色 `text-danger`。
   - `clients/chat-web/components/business/plan/schedule-preview-card.tsx`：依据 `installments.length` 动态显示 3 批或 1–2 批缩批提示，错误容器改用 `border-danger bg-danger text-danger`；新增 `schedule-preview-card.spec.tsx`。
5. **组织角色与审计日志全链路汉化及语义色收敛**
   - `clients/chat-web/components/business/organization/role-select.tsx`（及 `index.ts`）：导出 `ROLE_LABELS` 与 `formatOrganizationRole`，统一应用于 `organization-form.tsx`、`invitation-list.tsx`、`organization-switcher.tsx`、`invite-form.tsx` 与 `app/(protected)/invitations/[token]/page.tsx`（保留 `data-role`）。
   - `clients/chat-web/components/business/audit/audit-labels.ts`（及 `index.ts`）、`audit-filter.tsx`、`audit-log-table.tsx`：结果枚举（`成功` / `已拒绝` / `失败` + `data-result`）、目标类型与动作码均以中文展示（动作列保留等宽机器码供管理员筛选复制），并替换 `text-amber-600`/`text-red-600` 为 `text-commit`/`text-caution`/`text-danger`；同步更新 `e2e/modules/15-organization.spec.ts` 5 处断言并新增 `audit-labels.spec.ts`。
6. **登录切换 Tab 控制台报错、邮箱占位符与加载圈杂色**
   - `clients/chat-web/components/business/auth/login-form.tsx`：为密码/验证码双表单补充 `key="password"` / `key="otp"`，彻底消除切换「验证码登录」时的 React `uncontrolled -> controlled input` 控制台报错（`1 Issue`）；与 `register-form.tsx` 统一邮箱占位符为 `请输入邮箱地址`。
   - `clients/chat-web/components/base/page-loading.tsx`：全局加载圈由 `text-blue-600` 调整为 `text-ink-600`。
7. **`/chat` 503 未配置 / 未开放温和降级态**
   - `clients/chat-web/lib/api/client.ts`（及 `AGENTS.md` 注释、`client.spec.ts`）：`isExpectedControlFlowApiError` 纳入 `503 AI_NOT_CONFIGURED` / `AI_DISABLED`，避免本地未配模型密钥时上报 `captureApiError` 错误噪音。
   - `clients/chat-web/components/business/chat/chat-input.tsx` & `chat-workspace.tsx`：遇 `503` 展示温和提示卡片（`data-testid="chat-service-unavailable"`）并禁用输入区、移除 `red-*` 残留类名；新增 `chat-workspace.spec.tsx`。

---

## 二、原型真源与延期项文档收口

- `design-harness/README.md`：明确声明以 `design-harness/` + `changes/product-harness-agent/` 为当前前端 UI/交互唯一权威真源，仓库内 `FXplanner-V2.5-MVP用户交互原型.pen` 中被 ToB 覆写的 4 张基础画板与 `[78]–[87]` 企业 Agent 画板不再作为个人工作台文案与 `/chat` 布局依据。
- `docs/ITERATION-REFACTOR-ROADMAP-20261119.md`：明确登记 2026-11-28 拍板后置的「设置内变更本位币及停旧建新（`SM05` / `STOPPED`）」与「独立静态 `/terms`、`/privacy` 正文页（`WEB-03`）」。

---

## 三、验证结果（隔离 Worktree 内全量实测，0 failed）

| 检查项 | 命令 | 结果 |
| :--- | :--- | :--- |
| 静态护栏与 `--enforce` | `bun run lint` | 通过：`check:structure` ✅、`check:org-scope`（69 文件 0 违规）✅、`check:compliance-copy`（388 文件 0 违规）✅、`clients/chat-web` **0 errors, 0 warnings（273 文件）** ✅、`services/chat` **0 errors, 0 warnings（285 文件）** ✅ |
| 非缓存类型检查 | `bunx turbo run typecheck --force` | 通过：4/4 包 PASS（0 cached） |
| 后端单元（含属性测试） | `bun run test unit` | 通过：52 files，759 passed（1 既有 todo） |
| 前端单元（含路由扫描守卫） | `bun run test web` | 通过：45 files，464 passed |
| 精度纯函数包（含 `fast-check`） | `bun run test money` | 通过：4 files，64 passed |
| 开发日志包 | `bun run test dev-log` | 通过：4 files，31 passed |
| 工程脚本门禁单测 | `bun run test scripts` | 通过：5 files，38 passed（116 expect） |
| 非缓存生产构建 | `bunx turbo run build --force` | 通过：`@fxplanner-new/chat` + `@fxplanner-new/chat-web`（21 路由）全部 PASS（0 cached） |
