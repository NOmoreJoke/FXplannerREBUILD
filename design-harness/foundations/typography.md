---
title: 字体层级——衬线仅作温润刊头，数字一律无衬线等宽对齐
slug: typography-serif-masthead-tabular-nums
description: 品牌字标与卡片主标题使用衬线体营造存折手账感；所有金额、汇率、日期强制无衬线 tabular-nums，字体本地自托管。
---

## Rule
1. **衬线体适用边界（`font-display` / `font-song`）**：仅用于 `FXPlanner` 品牌字标、落地页主标题及存折检视台卡片主标题（`h1` / `h2`），赋予温润沉静的手账刊头气质。
2. **数字铁律（`font-sans tabular-nums`）**：所有金额、汇率、百分比、日期、时间与凭证编号一律使用无衬线字体 + `tabular-nums` 等宽数字——**即使出现在衬线标题内部的数字与币种代码（如 `2,000,000 JPY`），也必须包裹 `font-sans tabular-nums`**。
3. **本地自托管零外链**：拉丁衬线刊头字体（`Playfair Display` 可变子集 `.woff2`）存放于 `clients/chat-web/public/fonts/` 并经 `next/font/local` 加载；中文衬线与无衬线直接回退系统原生高品质字体栈（`Songti SC / STSong`、`PingFang SC / Microsoft YaHei`），**严禁依赖 `fonts.googleapis.com` 远程加载**。

## Why it holds
- 多行批次与前后对比数字只有逐位垂直对齐，用户扫一眼才能看清差额与小数位，零视错觉。
- 中国大陆网络环境下 Google Fonts 经常超时阻塞或引发版面跳动（FOUT），本地自托管子集 + 原生中文字体栈实现 0ms 稳定首屏渲染。

## When it doesn't
- 对话气泡内自然口语提及的少量序数词（如「分 3 批」「第 1 步」「2 笔换汇」）无需强制切分包裹等宽类名。
