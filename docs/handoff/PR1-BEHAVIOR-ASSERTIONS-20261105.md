# FXplanner PR#1 收尾 · 行为断言清单（pstack 回写）

原则：**Test Behavior, Not Implementation**；拒 tautological 测试扩面。

## 必验行为（用户可观察）

| ID | 行为 | 证明 |
| --- | --- | --- |
| B1 | 落地页/首页/报告可见最小免责声明 | 页面文案存在；非仅注释 |
| B2 | Onboarding 30 天：书面降级已记录，不假装已实现 | handoff/文档边界清晰 |
| B3 | Mimosa 门禁：已知绕过路径有披露或已收口 | 见 MIMOSA-GATE 笔记 |
| B4 | 关键路径可演示：登录→建账→计划相关入口不断裂 | 现有 E2E 子集绿即可，不新堆同义测试 |

## 不做

- 为「覆盖率数字」加只断言内部 mock 的测试
- 改生产/merge/runner 未获批
- 用公仓躲 Actions 分钟

## 验证与审查增量约束（2026-11-17 Anthropic Verification 2.0 同步）

- **三类核心防线**：除上述可见行为（B1–B4）E2E 外，涉及 `packages/money/` 金额/汇率纯函数改动须配 `fast-check` 属性测试；涉及旧版换汇逻辑迁移须配差分测试（以旧实现为 Oracle）。
- **本地 3 轮熔断 & Flaky 零容忍**：同一报错连续自愈 3 轮未果立即停机汇报；禁止为刷绿删断言、加 `sleep` 或 `skip`。
- **审查三态标签**：独立复核结论强制标 **`[Important]` / `[Nit]` / `[Pre-existing]`**；存量问题记录进 backlog，不阻断当前 PR。
- **Commit 验证戳记**：提交尾部附 `Verified: <unit|property|api|e2e|diff|none (reason)>`；遇 Mimosa 结构性 Catch-22 按 `MIMOSA-GATE-20261105.md` 写明豁免理由与实测证据，不做无记录静默旁路。
