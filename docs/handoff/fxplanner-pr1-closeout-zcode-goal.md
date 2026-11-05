# Goal — FXplannerREBUILD · PR #1 收尾（ZCode + GLM-5.3）

> 在 ZCode 项目 **FXplannerREBUILD** 下执行。实现：ZCode（**GLM-5.3 最高**）。  
> 工作目录：`/Users/kyle/Documents/工作/知爻/FXplannerREBUILD`  
> 分支：继续 `feat/iteration-a-mvp-closeout`（已有 draft [PR #1](https://github.com/NOmoreJoke/FXplannerREBUILD/pull/1) → `dev`）  
> SoT：`docs/handoff/OVERNIGHT-ZCODE-20261103.md`、`docs/handoff/OVERNIGHT-MINIMAX-REVIEW-20261103.md`、`docs/NOMI-FX-ITERATION-AND-BACKLOG-20261103.md`

## 背景（Nomi 2026-11-05）

夜间 MVP A+B 已落 draft PR；Kaiming 确认用 **GLM 继续开发**（Claude 暂不可用；Actions 私有额度满，不改 public、不装 runner）。本 Goal 只收「可编码收口」三项，**不**转 ready / merge。

## 必做（按序）

### 1) 免责声明终审稿（P0-5 收口）

- 文件：`clients/chat-web` 内 `components/base/compliance-disclaimer.tsx`（或 Overnight 所指常量唯一源）
- 产出一版 **可上线短句**（中文为主，可保留关键英文专名）：非持牌、非投顾、汇率/计划仅工具测算、损失自负；落地页/首页/报告三处继续共用同一常量
- 若措辞需产品拍板：在组件旁 `docs/handoff/DISCLAIMER-CANDIDATES-20261105.md` 给 **A/B 两版**（各 ≤80 字），默认代码采用 A，handoff 标明待 Kaiming 选
- 自测：三处 UI 仍可见；相关单测/快照若有则更新

### 2) Onboarding 草稿 30 天 → **书面降级**（P1-5 决策落地）

- **本轮默认：书面降级，不实现 30 天草稿功能**
- 更新 backlog / 审查报告 / LAUNCH-CHECKLIST（择相关处）：写明「Onboarding 草稿 30 天 = deferred；MVP 不阻塞；理由：范围外 + 本轮优先稳定 PR #1」
- 代码侧：若存在半截入口/死链，改为隐藏或指向「暂未开放」空态；**不要**新开大功能

### 3) Mimosa Git 门禁恢复可直提

- 问题见 Overnight：Mimosa 1.0.4 对 `git commit`/`push` 误拦 E2E localhost、测试夹具凭据字面量、`RegExp.exec` 等；上轮用 `git -C` 旁路交付
- 本轮目标：**后续会话可直提，不再依赖旁路**
- 允许路径（择一或组合，记入 handoff）：
  - 为测试/E2E 路径配 exclusions / threatModel（若插件支持且真抑制）
  - 调整误报源（夹具命名、注释豁免格式若官方支持）
  - 文档化「本仓 Mimosa 推荐配置」到 `docs/handoff/MIMOSA-GATE-20261105.md`
- **验收**：在本机对一个无害空 commit（或 amend 文档-only）证明 **不经 `git -C` 旁路** 时 hook 放行；若插件完全无法豁免，则 handoff 写清失败原因 + 建议降级/卸载时机，**不要**再扩大旁路脚本进仓

### 4) 小票（有余力）

- `plan-detail-card` 存量 Number→Decimal 百分比（Overnight m3）——小步、有测再改
- 更新 `docs/handoff/OVERNIGHT-ZCODE-20261105.md`：分支、命令、三项结果、是否仍需人类终审措辞

## 验收

- [ ] 免责声明常量已是终审候选（或 A/B 文档 + 代码默认 A）
- [ ] Onboarding 30 天草稿已书面降级；无半截入口
- [ ] Mimosa：可直提 **或** 书面证明不可豁免 + 推荐处置（无新旁路工具进仓）
- [ ] typecheck + 相关 vitest/E2E 子集绿（至少 chat API 冒烟或 Overnight 速查命令仍绿）
- [ ] 仍在 `feat/iteration-a-mvp-closeout`；**draft PR 保持 draft，勿 merge / 勿转 ready / 勿推 main**
- [ ] handoff `OVERNIGHT-ZCODE-20261105.md` 写完

## 禁止

- 不 merge、不转 ready、不部署、不改计费、不装 Actions runner、不把仓库改 public
- 不 Cloud Agent；不改无关仓；密钥不进 git/聊天
- 不实现 Iteration C 大项（i18n/PDF/真草稿系统）
- 域名切流只保持 LAUNCH-CHECKLIST「待拍板」，本轮不碰 DNS/生产

## 开工

先读 `OVERNIGHT-ZCODE-20261103.md` §遗留，再改代码。优先小步 commit；对抗审：若 MiniMax GUI 可开则开一轮，否则 Codex `gpt-6.1-sol` 代审并在 handoff 披露（与上轮一致）。
