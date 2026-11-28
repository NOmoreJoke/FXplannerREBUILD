---
title: 字体层级——衬线仅作温润刊头，数字一律无衬线等宽对齐
slug: typography-serif-masthead-tabular-nums
description: 拉丁品牌字标本地自托管多字重渲染；中文衬线走免外链系统字体栈并显式约束跨平台退化与防合成粗体策略；所有金额、汇率、日期强制无衬线 tabular-nums。
---

## Rule
1. **衬线体适用边界（`font-display` / `font-song`）**：仅用于 `FXPlanner` 品牌字标、落地页主标题及存折检视台卡片主标题（`h1` / `h2`），赋予温润沉静的手账刊头气质。
2. **数字铁律（`font-sans tabular-nums`）**：所有金额、汇率、百分比、日期、时间与凭证编号一律使用无衬线字体 + `tabular-nums` 等宽数字——**即使出现在衬线标题内部的数字与币种代码（如 `2,000,000 JPY`），也必须包裹 `font-sans tabular-nums`**。
3. **本地自托管零外链**：拉丁衬线刊头字体（`Playfair Display` 可变子集 `.woff2`，仅含拉丁字形、`400–900` 连续字重，随附 `OFL.txt` 许可证与 SHA-256 出处）存放于 `clients/chat-web/public/fonts/` 并经 `next/font/local` 加载；中文衬线与无衬线直接回退系统字体栈，**严禁依赖 `fonts.googleapis.com` 远程加载**。
4. **跨平台中文衬线渲染矩阵与防合成粗体铁律**：
   - **macOS / iOS**：命中系统原生 `Songti SC` / `STSong`（含真实细/中/粗多字重），中文衬线刊头直接呈现 0ms 渲染。
   - **桌面 Linux / 已装思源宋体环境**：命中 `"Source Han Serif SC"` / `"Noto Serif CJK SC"` 多字重宋体。
   - **Windows 默认环境**：前序宋体缺失时回落至单字重（`400`）`SimSun`（中易宋体）。若对中文衬线节点叠加 `font-semibold` (`600`) 或 `font-bold` (`700`)，浏览器会触发 **合成粗体（Synthetic Bold）** 导致笔画发虚粘连。因此：
     - 拉丁品牌字标 `FXPlanner`（由 `Playfair Display` 可变字库渲染）可使用 `font-semibold`；
     - 新增中文 `ProposalSurface` / 检视台卡片 `h1`/`h2` 主标题（Stage 1 `W43` 起）**统一使用 `font-medium`（`500`，低于浏览器 `>=600` 合成加粗阈值）或显式 `font-synthesis-weight: none`**，改用字号阶梯（`18px–24px`）与 `ink-900` 对比度建立视觉层级。
   - **Android 与微信 WebView**：未预装 `Songti SC`、`Noto Serif CJK SC` 与 `SimSun`，通用 `serif` 会由系统无衬线字体（如 `Noto Sans CJK` 黑体）兜底——此处是明确的架构取舍：**以移动端 Android 中文衬线装饰感优雅降级为代价，换取大陆网络环境下零外链超时阻塞与零版面跳动（FOUT）**（若后续 Stage 1 视觉评审要求全平台严格中文衬线一致，再单立构建期 CJK 标题子集评估，不得私自恢复 Google Fonts）。

## Why it holds
- 多行批次与前后对比数字只有逐位垂直对齐，用户扫一眼才能看清差额与小数位，零视错觉。
- 中国大陆网络环境下 Google Fonts 经常超时阻塞或引发版面跳动（FOUT）；本地 `.woff2` 保障了全平台 `FXPlanner` 品牌字标的一致性，系统字体栈 + 上述防合成粗体规则保障了无阻塞且不糊字的跨端可读性。

## When it doesn't
- 对话气泡内自然口语提及的少量序数词（如「分 3 批」「第 1 步」「2 笔换汇」）无需强制切分包裹等宽类名。
- **macOS E2E 校验盲区**：本仓 Playwright E2E 运行在 macOS 上（默认命中 `Songti SC`），无法自动发现 Windows `SimSun` 合成粗体或 Android 黑体兜底退化；Stage 1（`W43`/`W44`）检视台中文衬线标题上线前，必须在 DevTools 临时屏蔽 `Songti SC / STSong` 后做降级状态目视复核。
