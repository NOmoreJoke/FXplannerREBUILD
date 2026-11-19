# FXplannerREBUILD · PR #1 收口交接（2026-11-19）

本轮归档工程规范、ToB 待评审方案与 V2.5 原型，落档免责声明 A 版，并将修改使用记录标为 🟡 降级待修（MVP-F0-3）。交付分支为 `feat/iteration-a-mvp-closeout`，目标是 [draft PR #1](https://github.com/NOmoreJoke/FXplannerREBUILD/pull/1) → `dev`。人工核对 PR 检查和既有业务 diff 并合并后，从干净的 `dev` 启动 `docs/handoff/GOAL-1-MVP-F0-GUARDRAILS-20261119.md`。

## 提交与产物

| 主题 | 提交 | 交付 |
| --- | --- | --- |
| 工程规范与工作流 | `597099e` | 目录登记、验证规范、路线图、工作流手册、PR 行为断言、Goal #0–#2 |
| ToB 规划 | `e588cef` | `changes/tob-agent-workspace/` 的需求与技术方案，状态为待评审、未实施 |
| V2.5 交互原型 | `888ef8f` | 静态解析通过，顶层节点由 78 增至 88，原有节点 ID 全部保留。另有 22 个旧节点的文案更新，未做 Pencil 渲染或交互走查 |
| D5 与进度纠偏 | `dc34cf1` | A 版 70 字与源码常量逐字一致。服务端仍拒绝 `USAGE`，`T-CORR-004` 仍跳过，待 Goal #1 完成 MVP-F0-3 验收后恢复 ✅ |

已移出根目录测试产物、开发日志、11 个导出 ZIP 和 41 张 ZCode 会话截图。其中 17 张为此 PR 的旧提交引入，`dev` 无对应文件，仓库文档也未引用具体图片。按交接约定将它们移出 PR 最终文件树并加入定向忽略规则，原提交仍保留历史。检查时 `e2e/test-results/` 不存在。临时恢复位置为本机私有目录 `$TMPDIR/fxplanner-pr1-artifacts-23r8el3_`。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 4 个任务成功，0 error |
| `bun run lint` | 2 个任务成功，当前 lint 脚本执行 TypeScript 检查 |
| `bun run test unit web scripts` | 后端 421 通过、5 跳过、1 todo。回填套件的初始化无法连接本地 PostgreSQL `localhost:5432`，套件退出失败。前端 Node 26 下 `use-chat` 的 `localStorage` 出现 14 项失败，改用本机 Node 24.15.0 后 231 项全过。脚本套件目录缺失，命令报告跳过 |
| `bun run changeset status --since=504f396` | 无包需要发版 |
| Git 差异与工作区 | `git diff --check 504f396..HEAD` 通过。按 `git diff origin/dev...HEAD --stat` 查看整个 PR，再以原 PR 头 `504f396` 比对本轮增量，受保护目录和 E2E diff 为空。整个 PR 带有既有业务 diff |

本轮未执行 Playwright E2E、API 和集成套件。PR #1 上一个头 `504f396` 的 GitHub CI 中，类型检查通过，`services/chat/test/api/ai-chat.spec.ts` 的中途 abort 用例以 `AbortError` 失败。收口提交后的 GitHub CI 由本次分支推送触发。

## D4 · 本地 Mimosa

- 当前 Codex 会话以普通 `git commit` 提交成功，`core.hooksPath=.husky/_`，Husky 与 commitlint 正常执行。无需历史记录中的 `git -C "$PWD"` 提交形式。
- 已安装的 ZCode Mimosa 1.0.4 仍启用 `Edit|Write|MultiEdit` 写入前扫描。对 README 运行 Write hook，日志显示 `clear`、`complete`、0 项，退出码为 0。探针只向 hook 传入候选文本。
- 在独立进程中以官方 `MIMOSA_GIT_GATE_MODE=warn` 运行同版本 Git hook，使用普通 `git commit` 命令作为输入，退出码为 0，决策为空。L3 报告 111 项 high、19 项 medium，明确提示本次等级仅告警。已显示的条目包含历史记录中的测试 helper，计数为扫描器输出。
- `warn` 验证限于探针进程。桌面 ZCode 的全局设置仍由其宿主管理，本轮普通提交实际发生在 Codex 会话。历史拦截与记录要求见 `docs/handoff/MIMOSA-GATE-20261105.md` 和 `docs/VERIFY.md` §3。

## 独立对抗审

独立 Codex CLI 只读会话使用 `gpt-5.6-terra`。CLI 原配置模型被当前账号拒绝，改用该模型后取得完整审查结论。裁判规则来自 `dev` 基线 `1d0ace28`，初审范围为原 PR 头 `504f396` 至四个主题提交的初稿 `1ff3f36`。

- **[Important]** 已闭环。接力 Goal 和工作流手册统一引用已入库的 `docs/VERIFY.md`，本地可选技能不再是验证前置。
- **[Important]** 已闭环。随提交交付本报告，记录 `typecheck`、其他检查、独立审查结论及受限项。
- **[Nit]** 源码注释仍称 A 版为候选，当前展示文案与最终选定的 A 版一致。注释留待后续业务源码变更时同步。
- **[Pre-existing]** 两份工程指南的格式示例曾引用不存在的示例模块，本轮已替换为实际源码路径。

增量复核确认两项 `[Important]` 均已闭环。复核覆盖定向忽略与截图移除、验证报告及修订后的接力文档，无新增阻断。
