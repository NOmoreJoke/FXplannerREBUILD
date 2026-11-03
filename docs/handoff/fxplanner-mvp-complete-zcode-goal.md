# Goal — FXplannerREBUILD · 补齐 MVP 与功能（ZCode 实现 + MiniMax 审）

> 在 ZCode 项目 **FXplannerREBUILD** 下执行。实现：ZCode。审阅：由 **ZCode 调度 MiniMax Code** 对 PR/diff 做对抗审，修 blocker 后再交 Kaiming。  
> 工作目录：`/Users/kyle/Documents/工作/知爻/FXplannerREBUILD`  
> SoT：`docs/NOMI-FX-ITERATION-AND-BACKLOG-20261103.md`、`docs/开发计划/MVP开发计划.md`、`changes/mvp-completion/阶段5-收尾项方案.md`

## 目标

把快速上线 Must-have / Iteration A+B（及已列 P0）**全部补齐**到可本地演示、文档与完成度真相一致；Iteration C（i18n/PDF/草稿等）能做则做，做不完写入 handoff 明确 defer。

## 必做（P0 / Iteration A+B）

按 backlog 顺序落地并自测：

1. **P0-1** 首页正常态「新建计划」→ `/plans/new`（与录入买入并排）
2. **P0-2** 账户分配只读视图 + `GET /api/accounts/:currencyCode/allocations`
3. **P0-3** 计划列表准备进度条（对齐 plan-calculator gap / 阶段5 §3）
4. **P0-4** `e2e/modules/07-plan-lifecycle.spec.ts` 本地 0 failed
5. **P0-5** 落地页/首页/报告最小免责声明固化
6. **P0-6** typecheck + 关键 auth/plan/transaction/usage API 或 E2E 子集绿
7. **P0-7~9 / B** `docs/LOCAL_BOOTSTRAP.md`、`审查报告-20261103.md` 完成度表、`docs/LAUNCH-CHECKLIST.md`（只写不部署）、README SoT 链接

money 核心若测出缺口：顺手加固 `packages/money` quote→plan→validate（±persist）与单测，但不开大重构。

## MiniMax 调度（强制）

1. ZCode 完成一批可审 diff 后，**主动调度 MiniMax Code** 审 PR/分支 diff（不是口头自审）。
2. MiniMax checklist：钱/FX 正确性、UI 入口无死胡同、E2E 真实性、秘密泄漏、范围蔓延、CI 成本（勿无故改 workflow）。
3. MiniMax 结论写入 `docs/handoff/OVERNIGHT-MINIMAX-REVIEW-YYYYMMDD.md`；blocker 由 ZCode 修一轮再请 MiniMax 复看。
4. **未过 MiniMax blocker 复看前不要标完成。**

## 验收

- [ ] 已建账首页可见「新建计划」；账户页可见分配表；计划列表有进度条
- [ ] `07-plan-lifecycle` 与约定子集绿；`bun` typecheck 绿（或文档写明标准 filter 且绿）
- [ ] 合规短句可见；LOCAL_BOOTSTRAP / LAUNCH-CHECKLIST / 20261103 审查表已更新
- [ ] draft PR（勿 merge main）；`docs/handoff/OVERNIGHT-ZCODE-YYYYMMDD.md` 含分支/PR/命令/MiniMax 结论
- [ ] 证明已调度 MiniMax（handoff 或会话记录）

## 禁止

- 不 push/merge `main`、不生产部署、不改计费、不装 Actions runner
- 不 Cloud Agent；不改无关仓；密钥不进 git/聊天
- 不把 public 仓库当省分钟方案；勿大依赖升级

## 开工

先读 backlog §2–§4 与阶段5方案，再改代码。优先小步可演示 PR，而不是半成品大改。
