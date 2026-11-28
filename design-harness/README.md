# FXPlanner Frontend Design Harness

> **唯一权威设计底座**。任何前端页面新建、视觉翻新或组件微调前必读。

## 北极星宗旨（North Star Principle）

所有视觉、文案与交互取舍只服务两件事：
1. **提升用户信任感**：一眼分清「已在账本里的事实」与「知禾试算的预演」，数字可溯源、变化不静默、失败必写明「账本没有任何变化」。
2. **降低操作理解难度**：默认呈现纯粹温润的个人备款存折手账感（Solo-First），不把个人用户拖入企业审批术语；团队元素仅在多人工作台（`memberCount > 1`）按需浮现（Team-on-Demand）。

## 四层目录地图

| 层级 | 文件路径 | 核心职责 |
| :--- | :--- | :--- |
| **1. Foundations** | `design-harness/foundations/colors.md` | 语义色彩角色、唯一品牌绿 Jade、工具类清单与色阶禁令 |
| **1. Foundations** | `design-harness/foundations/typography.md` | 衬线刊头层级、无衬线等宽数字铁律与本地字体自托管 |
| **1. Foundations** | `design-harness/foundations/writing.md` | 白话表达、后果先行、动作写全与 Solo/Team 自适应措辞 |
| **2. Intelligence** | `design-harness/intelligence/policy.md` | 绝不做的事（Never-do）与交付前必过检查（Must-pass） |
| **2. Intelligence** | `design-harness/intelligence/zhihe-persona.md` | 陪伴伙伴「知禾（小禾）」人设口吻与去官僚化转译表 |
| **2. Intelligence** | `design-harness/intelligence/vocabulary.md` | 人机共享词汇表（账本实况 / 预演备款单 / 先买先用 / 回执签） |
| **2. Intelligence** | `design-harness/intelligence/memories/2026-11-27-zhihe-trust-first.md` | 关键设计拍板记忆（避免后续会话重复追问或回退） |
| **3. Components** | `design-harness/components/patterns/proposal-surface.md` | 存折备款预演单（Proposal Surface）与状态回执签模式 |
| **3. Components** | `design-harness/components/screens/collab-proposal-stage.md` | 知禾协作模式与备款检视台全 11 态规格（`1440px` + `390px`） |
| **4. Commands** | `design-harness/commands/workflow.md` | `Steer / Concept / Tune / Comment / Review` 五步协作规程 |

## 原型真源与历史资产边界

- **唯一权威真源**：当前前端视觉、文案与交互一律以 `design-harness/` 与 `changes/product-harness-agent/` 为准。
- **历史 `.pen` 原型界定**：`docs/MVP功能模块&业务逻辑&专业术语/FXplanner-V2.5-MVP用户交互原型.pen`（88 画板）仅作为 MVP 业务流与历史模块结构参考；其中在 ToB 阶段被覆写的 4 张基础画板（`pyTkx`、`JwhWw`、`Xo1xx`、`tX0mI`）及 `[78]–[87]` 企业 Agent 画板不再作为默认个人工作台文案与 `/chat` 布局依据。
