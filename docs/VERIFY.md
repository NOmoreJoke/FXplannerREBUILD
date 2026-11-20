# FXplannerREBUILD 验证驱动与防回归规范（VERIFY.md）

> 依据 Anthropic《How the Claude Code team thinks about verification》（2026-11-16）与 `AGENTS.md` 制定。
> 原则：**廉价检查先行、Test Behavior Not Implementation、防 Agent 同源盲区、3 轮自愈熔断**。

---

## 1. 确定性验证命令分级（由廉价到昂贵）

### L1：静态检查 + 单元 / 属性 / 脚本测试（每次改动必跑）
```bash
bun run typecheck
bun run lint
bun run test unit web scripts money dev-log
```
- 涉及 `packages/money/`（精度、舍入、汇率换算）时，**必须配备 `fast-check` 属性测试**，覆盖：
  1. **往返守恒（Round-trip）**：编码/序列化/币种换算往返误差在约定精度边界内；
  2. **不变量（Invariants）**：非负约束、精度不退化为 IEEE-754 浮点漂移（`0.1 + 0.2 !== 0.3`）、分拆合计守恒；
  3. **幂等性（Idempotency）**：归一化、重复更正/计算结果一致；
  4. **等价性（Equivalence）**：优化实现与朴素参考实现一致。

### L2：接口与集成测试（涉及后端逻辑/数据库/契约必跑）
```bash
bun run test api integration infra
```
- 涉及从旧版 `FXplanner` 迁移换汇计算、计划生成或更正流水时，补跑**差分测试（Differential Testing）**，以旧版输出或黄金样本集为 Oracle 同输入比对。

### L3：Playwright E2E（涉及前端业务流、页面路由、前后端联调）
> **严格遵守 `AGENTS.md` 红线**：AI **禁止自行启动** `dev` / `docker compose up` 服务。先确认人类已启动本地服务后再运行 E2E：
```bash
bun run test e2e
# 查看报告并留存必要日志后，提交前清理 gitignored 产物防止污染安全扫描：
rm -rf e2e/test-results
```

---

## 2. Diff 触发式可靠性清单（Trigger-based Checklist）

自检或独立复核时，根据 `git diff --name-only <base>...HEAD` 命中以下路径自动激活对应检查：

| Diff 触碰路径 / 特征 | 必触发专项检查 | 关联风险 / 历史教训 |
| :--- | :--- | :--- |
| `packages/money/**`、汇率/金额计算 | `fast-check` 属性测试（浮点精度、舍入守恒、极端汇率/零值边界） | 金融换汇精度漂移单向门 |
| `services/chat/src/**` DTO / OpenAPI 变更 | 运行 `bun run --cwd clients/chat-web generate:api` 并核对前端类型同步，严禁前端手写共享类型 | 前后端契约撕裂 |
| `clients/chat-web/app/page.tsx`、报告/计划展示页 | 核对最小合规免责声明可见性（非仅注释）与金额格式（`$200 USD`，禁止货币代码前置） | FX 合规红线与 PR#1 行为断言 B1 |
| `services/chat/test/**`、`e2e/**` 请求 helper 或测试凭据 | 测试凭据沿用 `env-first` 约定，后端夹具位于 `services/chat/test/fixtures/`。请求 helper 采用同函数回环校验，E2E 跑完清理 `e2e/test-results` | `docs/handoff/MIMOSA-GATE-20261105.md` 的 SSRF 和硬编码密钥拦截 |
| `services/chat/prisma/**`、数据修正 `corrections/` | 验证迁移可前滚/回滚、更正日志幂等性与不可篡改审计轨迹 | 金融账本数据完整性 |

---

## 3. 自愈熔断、Flaky 零容忍与审查规范

1. **本地自愈 3 轮熔断**：同一测试或构建失败连续自动修复 **3 轮**仍未通过，必须立即停机保存现场并向人类汇报，严禁死循环盲改。
2. **Flaky 测试零容忍**：严禁为刷绿删除有效断言、添加硬编码 `sleep`、盲目放大 timeout 或加 `skip`；3 轮内找不到根因则显式移除/隔离该测试并书面记账。
3. **独立审查与三态标签**：
   - 审查规则与门禁配置从 `main` / 基线分支读取，被审改动不得自改裁判标准。
   - 审查结论强制标注 **`[Important]`（必改阻断）/ `[Nit]`（非阻断建议）/ `[Pre-existing]`（存量问题，记账但不阻断当前 PR）**。
4. **Commit 验证戳记与门禁三态**：
   - 提交信息尾部附 `Verified: <unit|property|api|e2e|diff|none (reason)>`。
   - 新门禁遵循 `off → observe → enforce`；若遇已证实的结构性误报（见 `docs/handoff/MIMOSA-GATE-20261105.md`）或单会话连续拦截 2 次，第 3 次允许附书面原因与证据放行，禁止无记录静默旁路。
