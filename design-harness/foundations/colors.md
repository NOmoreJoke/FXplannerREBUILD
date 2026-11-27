---
title: 语义色彩角色、唯一品牌绿 Jade 与工具类清单
slug: colors-semantic-roles
description: 业务组件只用语义角色与中性灰阶 ink-*；Jade 为唯一品牌绿；绿色在操作层只表示「已记入账本 / 写账本」。
---

## Rule

### 1. 语义角色与工具类清单（注册于 `clients/chat-web/app/globals.css`）

| 语义角色 | 允许使用的工具类 | 视觉表现与用途 |
| :--- | :--- | :--- |
| **事实表面 (`surface-fact`)** | `bg-surface-fact` · `border-fact` · `border-l-fact` · `bg-commit-subtle` | 纯白底 + `ink-200` 细实线 + 左侧 `4px` `jade-700` 边线；用于已入账卡片、账本实况简报、已记好回执 |
| **预演表面 (`surface-proposal`)** | `border-proposal` · `bg-proposal-hatch` · `bg-surface-paper` | `1.5px` `ink-300` 虚线外框 + 账本表内柔和斜纹试算行 + 暖白衬底；用于所有未记入账本的知禾预演单 |
| **写账本主动作 (`action-commit`)** | `bg-commit` · `hover:bg-commit-hover` · `text-commit` · `border-commit` | `jade-700`（`#245b42`）悬停 `jade-800`（`#1a4733`）；**全站仅用于真正写入账本的确认按钮** |
| **常规主动作 (`action-primary`)** | `bg-ink-900` · `text-white`（或 shadcn `variant="default"`） | 深墨黑 `ink-900`；用于重新试算、回到账本、清理草稿、普通表单导航等非写账本主按钮 |
| **提醒信号 (`signal-caution`)** | `bg-caution` · `border-caution` · `text-caution` · `border-caution-rule` | 暖琥珀浅底 + 深琥珀字；用于余额已更新、参考报价超 5 分钟、手续费待补填（最低估计）、20 张上限提示 |
| **失败信号 (`signal-danger`)** | `bg-danger` · `border-danger` · `text-danger` · `border-danger-rule` | 柔和暖红底 + 深红字；用于接口异常或操作失败（文案必须同时写明「账本没有任何变化」） |
| **中性说明 (`signal-neutral`)** | `bg-neutral-note` · `border-neutral-note` | `ink-50` 浅底 + `ink-200` 细边；用于历史只读留档、已取消计划收起说明、多人团队分工说明 |
| **品牌标识 (`brand-mark`)** | `bg-brand` · `text-brand` · `border-brand` | **唯一例外**：左上角 `FX` 方块 Logo、品牌名与知禾 `禾` 字头像微章可使用 Jade，不受「仅限写账本」约束 |

### 2. 原始色阶使用政策（Stage 0b 起由 ESLint 硬拦截）

| 色阶族 | 业务组件能否直接写 | 规则说明 |
| :--- | :---: | :--- |
| `ink-*` | ✅ 允许 | 中性灰阶用于正文、次要说明、分割线、中性胶囊，语义纯粹，不强行二次包装 |
| `jade-*` | ❌ 禁止直写 | 必须通过上述语义类（`bg-commit`、`border-l-fact`、`bg-brand` 等）间接消费 |
| `mint-*` | ❌ 禁止直写 | Stage 0b 完成四类迁移后从 `@theme` 彻底删除 |
| `cream-*` | ❌ 禁止直写 | Stage 0b 统一收编为 `bg-caution / border-caution / text-caution` 或 `bg-surface-paper` |
| `lilac-*` | ❌ 禁止直写 | 历史遗留选中色，统一收敛为 Jade 焦点环 `--shadow-select` 与中性态 |

## Why it holds
- 只有把绿色收敛给「真实账本事实与确认入账按钮」，用户形成肌肉记忆后看到绿色才会有笃定的安全感。
- 预演与事实同时靠**线型（虚线 vs 实线左绿边）+ 斜纹肌理 + 状态回执签**三重区分，色弱用户与黑白打印均不会混淆。
- 提醒色（`caution`）与暖白纸面（`surface-paper`）对比度拉开，避免「米色提醒叠在米色卡片上」看不清关键变化。

## When it doesn't
- 行情走势与统计图表（`recharts`）可使用独立图表序列变量（`--chart-1..5`），但避免拿 `jade-700` 表示未实现的预估曲线。
- 本期仅覆盖浅色模式（Light Mode），`.dark` 暂不纳入 Design Complete 验收范围。
