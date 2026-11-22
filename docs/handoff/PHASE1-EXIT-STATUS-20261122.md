# Phase 1 退出门 · 状态快照（2026-11-22）

## 结论

Phase 1（MVP-F0 正确性硬门，roadmap 第 103 行退出门）**尚未关闭**：L3 E2E 补跑已完成两轮，
75 用例中 74/75 路径已验证（含 2 个环境性用例在汇率源健康时通过、级联假败已修复归零），
仅剩 **T-AI-003 一个用例**因「追问流 ERR_ABORTED」待专项调试（详见下文 L3 记录与证据链）。

对抗审状态：各分支切片均已 PASS（0 `[Important]`，见 `OVERNIGHT-ZCODE-20261119.md`），不在本快照重复记录。

## L3 E2E 补跑记录（2026-11-22，本会话执行）

**红线豁免记录**：`run-e2e-tests.sh` 内部执行 `bun run dev`，按 AGENTS.md 禁启服务红线原需人类执行。
本会话经 Kyle 明确授权（「帮我执行」）代跑三轮，属一次性记录在案的豁免；后续默认恢复人类执行。

| 轮次 | 范围 | 结果 | 结论 |
| --- | --- | --- | --- |
| 全量第 1 轮 | 75 用例 | 59 passed / 5 failed（14.2m） | 失败：T-RPT-001、T-DATA-007、T-AI-003/004/006 |
| 定向重跑 | 5 失败 + AI 全组 | T-RPT-001 ✓、T-DATA-007 ✓、T-AI-003/004/006 复现 | 环境性确认 + AI 失败确定性 |
| 修复后定向 | T-AI 全组 + 2 环境用例 | T-AI-004/006/007 ✓、T-AI-003 仍失败 | seeder 级联修复实证生效 |

### 根因 ①：汇率源不可用/迟缓（T-RPT-001、T-DATA-007）— 环境性，已验证

- 后端日志 3 次「汇率服务取价失败（整体异常）」；frankfurter 恢复后两用例均通过（T-DATA-007 由 2.0m 超时转为 1.2m 通过）。
- 处置：无需代码修复。T-DATA-007 含 61s 设计等待 + 造数依赖外部汇率，汇率源迟缓时逼近 120s 用例上限，**若再遇超时优先查汇率源健康度**。

### 根因 ②：beforeAll 重跑换新用户 × 跨用例状态依赖（T-AI-004/006 级联）— 已修复并验证

- 机制：Playwright 对失败用例重试（retries=1）会重跑 beforeAll；`seedRegisterAndLogin` 以 `Date.now()` 注册全新用户 → 依赖 T-AI-002 所建会话（convA）的 T-AI-003/004/006 在重试/后续用例中必然假败。**服务端数据全程完好**（DB 实查 convA 从未被删除），属身份切换假象。
- 修复（已落盘，实证生效）：`e2e/scripts/run-e2e-tests.sh` 注入 `E2E_SEED_RUN_ID`（单次运行稳定）；`e2e/helpers/api-seeder.ts` 以 RUN_ID 固定邮箱，register 撞 409「该邮箱已被注册」改走 login 复用同一用户；跨运行自动更换保持隔离。修复后 T-AI-006 在同一会话追问成功 ✓。

### 根因 ③：追问流 ERR_ABORTED（T-AI-003）— 未结案，证据链完整

- 现象：`POST /api/ai/conversations/:id/messages`（追问路由）的 SSE 在客户端 ~4-25ms 内被掐（`net::ERR_ABORTED`），后端经 res close 收到断连 → abort → WARN「This operation was aborted」→ 助手回复不落库。**新建会话路由（POST /api/ai/conversations）的流从未复现此问题**；T-AI-005 的 abort 是停止钮设计路径。
- 已排除（均有实证）：JS 层 `AbortController.abort()`（插桩零命中）；服务端 keep-alive 空闲回收（Node 复现脚本：60s 配置下 6s 空闲复用连接完整走完 SSE；且 60s 修复在位时 E2E 仍在 6s 间隔处复现）；数据丢失（DB 实查）；并行干扰（workers=1）；后端重启（单次启动）；CORS/响应头（trace 头完整）。
- 伴随异常：单次点击出现多条 POST（T-AI-005 一次点击两条 POST，首条 ERR_ABORTED 未达后端；T-AI-006 三条 200 POST 仅一条触发后端流）。
- 主嫌疑（未定罪）：React 渲染层 / Next dev 环境对 SSE 消费循环与发送路径的深层交互；另「刷新后会话列表拿到 200 数据但不渲染（暂无会话）」的伴随现象指向 react-query 状态/订阅层。
- 已回退：keepAliveTimeout 上调（main.ts）与全部临时插桩——修复未被证实前不留在生产代码。
- **建议**：为 changes/ai-assistant 开专项调试任务（条件断点 + React DevTools + 网络层逐帧比对），结案前 T-AI-003 保持显式失败记录，不刷绿不跳过。

## 本会话完成

## 本会话完成

### 1. E2E 补跑就绪度核查（全部通过）

- PostgreSQL `127.0.0.1:5432` 在线；库 `fxplanner_new_db_local` 存在，`_prisma_migrations` 18 条已应用。
- `.env.local`：`WEB_PORT=3001 / API_PORT=4001 / DEV_LOG_PORT=8788`；`services/chat/.env.local` 的 `DATABASE_URL` 指向 `fxplanner_new_db_local`，与外部传入的 `FXPLANNER_E2E_QUOTE_DATABASE` 一致。
- `FXPLANNER_E2E_QUOTE_DATABASE` 是报价更正 E2E 的**安全闸门**（`e2e/helpers/correction-quote-db.ts`）：该 E2E 会写全局报价，环境变量值必须等于 `DATABASE_URL` 中的库名且主机为本地，否则用例直接抛错拒绝执行。
- `e2e/modules/` 19 个 spec，`T-CORR-004` 在位；Playwright 1.61.1 就绪。
- `e2e/scripts/run-e2e-tests.sh` 内部执行 `bun run dev`（脚本统一管理服务生命周期）→ 按 `AGENTS.md` 禁启服务红线，**该脚本必须由人类执行**。

### 2. web 套件基线修复（本会话唯一代码改动）

- **发现**：`bun run test web` 失败——`use-chat.spec.tsx` 14/14 用例崩于 zustand persist `Cannot read properties of undefined (reading 'setItem')`。此前 dd3d4c1（Verified: unit）与 d0dbb33（Verified: unit）均未跑 web 套件，红态存在时长未知。
- **根因**：Node ≥26 在 `globalThis` 自带返回 undefined 的原生 `localStorage` getter，遮蔽 vitest 4 `populateGlobal` 注入的 jsdom localStorage（vitest#8757）。jsdom 29 原始实例（`globalThis.jsdom.window.localStorage`）完好，chat-store 与测试代码均无过错。全仓仅 `chat-store.ts` 使用 persist，影响面为单文件。
- **修复**：`clients/chat-web/lib/hooks/use-chat.spec.tsx` 顶部 `vi.hoisted` 从原始 jsdom 实例回填 `globalThis`/`window` 的 localStorage，覆盖被遮蔽 getter。修复落地在既有文件内，未新增路径（setupFiles 统一方案需新文件，按目录树规则留待报批）。
- **验证**：web 套件全绿；typecheck / lint 绿。
- **后续建议（不阻断退出门）**：若再新增 persist store 测试，建立 vitest `setupFiles` 统一 stub；vitest 修复 #8757 后移除本段。

### 3. GitHub PR refs 安全核查（收尾项 2 的前置事实）

- `refs/pull/1..8/head` 逐个只读 fetch 核查：**均无 .env 类文件** → 暴露面仅为清理前代码/IP，不涉凭据，无需轮换密钥。
- 本地清理后全分支历史无 `.env` 提交；`.gitignore` 覆盖 `.env` / `.env.*`（`!.env*.example`）。
- 因此「切 Private」是充分的收尾动作：仓库转私后 pull refs 立即不可公开访问；GitHub Support 清理为可选的锦上添花（响应以天计，非必需）。

### 4. 过程教训（非显见，供后续会话参考）

- `bun run test all` = **全量含 e2e**（`scripts/test.ts` `all` 分支返回 SUITES 全集）；廉价检查必须用显式套件清单 `unit api integration infra web scripts money dev-log`（`AGENTS.md` 所载命令本就正确，勿用 `all` 代劳）。
- 对照提交戳记核查套件覆盖：仅跑过 `unit` 的提交不能证明 web/E2E 套件健康。

## 待人工动作（Phase 1 退出门闭环）

1. **T-AI-003 专项调试**（唯一阻断项）：按上文根因 ③ 证据链开独立调试会话；结案后重跑 AI 模块确认全绿。
2. **提交工作区 diff**（3 处，均已验证）：
   - `fix(test): 回填 Node26 遮蔽的 jsdom localStorage，修复 use-chat persist 崩溃`（use-chat.spec.tsx）— `Verified: web`
   - `fix(test): E2E 种子用户按运行 ID 幂等化，消除重试级联假败`（api-seeder.ts + run-e2e-tests.sh）— `Verified: e2e`（T-AI-004/006 转绿实证）
   - `docs(handoff): Phase 1 退出门状态快照`（本文件）— `Verified: diff`
3. **GitHub 可见性**：建议将 `NOmoreJoke/FXplannerREBUILD` 切为 Private（`gh repo edit NOmoreJoke/FXplannerREBUILD --visibility private --accept-visibility-change-consequences`）；PR refs 已核查无凭据，切私即充分，Support 清理可选。
4. T-AI-003 结案 + 全量 L3 0 failed 后：`rm -rf e2e/test-results`、回填退出门结论并关闭 Phase 1。
