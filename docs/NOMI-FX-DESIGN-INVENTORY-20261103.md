# FXplanner 原型 / 功能设计 / 约定盘点

- 日期：2026-11-03（Asia/Shanghai）
- 机器：Kaiming Mac `468a331a-9f27-4f92-8a52-56286224483d`
- 目的：补齐 `NOMI-FX-CONSOLIDATION-20261103.md` **未单独展开**的设计与约定层；本文件只盘点与标注权威性，**未删文件、未改应用代码**。
- 诚实结论：**此前整合简报只点到「有 Pencil/PRD/术语包」——不算盘清；本附录把原型、模块规格、约定锁点与冲突面列全。内容级「逐条核验每份 docx 与 pen 画板」仍属后续产品确认，不是本文件声称已完成的事。**

---

## 0. 给 Kaiming 的一句话

| 问题 | 答 |
| --- | --- |
| 原型与功能约定都盘清楚了吗？ | **路径与版本族已盘清（本附录）**；REBUILD 工程侧约定（`AGENTS.md`、`packages/money`、Prisma 字段）清楚；**产品规格完整真源在 `知爻/FXplanner`，REBUILD/docs 是缩水副本**；旧 Vue PRD/合规仍是旁路参考。未发现 Figma 链接。 |

### MVP 建议优先打开的 5 个权威源

1. `知爻/FXplanner/MVP功能模块&业务逻辑&专业术语/00_MVP_PRD.md` + 同目录 `01–18`（**完整规格；REBUILD 缺 00/16–19**）
2. 同目录 `FXplanner-V2.5-MVP用户交互原型.pen`（**最新交互 pen，2026-09-27**；REBUILD 已有副本）
3. `知爻/FXplanner/FXplanner_MVP_Agent_PRD_V0.2.md` + `outputs/Agent第一阶段设计_20260923/`（Agent 契约 / prompts / OpenAPI）
4. `FXplannerREBUILD/packages/money/` + `AGENTS.md`（金额/汇率/目录铁律，工程 SoT）
5. `Code/Project/FXplanner/docs/COMPLIANCE_RESEARCH_2026-06.md` + `scripts/compliance-lint.mjs`（对外话术与封杀词；**规则移植，不移植旧栈代码**）

---

## 1. 原型资产目录

### 1.1 Pencil（`.pen`）— 按「该用哪版」排序

| 版本 / 文件 | 路径 | mtime（约） | 角色 | MVP 用法 |
| --- | --- | --- | --- | --- |
| **V2.5** MVP 用户交互 | `知爻/FXplanner/MVP…/FXplanner-V2.5-MVP用户交互原型.pen`；副本在 `FXplannerREBUILD/docs/MVP…/` 与 `FXPlanner-new/docs/MVP…/` | 2026-09-27 | **当前交互原型首选** | 上线 UI 对齐优先对照此版 |
| **V2.4** 功能模块中文评审 | 同上三处 `…V2.4-功能模块原型-中文评审版.pen` | 2026-09-07 | 模块评审版 | 与 V2.5 并存；模块切块时用 |
| **V2.0** 全量中英双语 | 仅完整存在于 `知爻/FXplanner/MVP…/FXplanner-V2.0-全量交互原型-中英双语排版.pen`（~8.8MB） | 2026-09-11 | 全量画板 | REBUILD **未拷**；资料库保留 |
| **V2.1 / V2.2 / V2.3** 业务场景 / 流程图驱动 | `知爻/FXplanner/` 根目录多份 `.pen`；`00_资料导航/02_Pencil原型/` 多为符号链接 | 2026-08-26 | 流转/拓扑修正过程版 | 历史；导航 README 也不自动认定最新 |
| **V1.2.0** 验收原型 | **实件**在 `Code/Project/FXplanner-V1.2.0/design/FXplanner-V1.2.0-验收原型.pen`（及 pdf）；`知爻/FXplanner/00_资料导航/02_Pencil原型/` 指向 `../../FXplanner-V1.2.0-完整验收原型.pen` → **根目录目标缺失 = 断链** | 旧栈 | 旧 Vue 验收 | 勿当 REBUILD UI SoT |
| 旧栈其它 pen | `Code/Project/FXplanner/design/`：`web-design.pen`、`web-design-v2.pen`、中文浅色链路/分层 | 更早 | 旧 Web 设计 | 只读考古 |
| 过程 pen | `知爻/FXplanner/outputs/MVP登录初始化一致性_20260910/保存复核.pen` 等 | 2026-09 | 一致性复核 | 过程证据 |

### 1.2 Figma

- 在所列根目录对 `figma.com` 的检索：**未发现**产品 Figma 链接或导出索引。
- 当前设计主载体是 **Pencil + HTML 演示 + drawio**，不是 Figma。

### 1.3 HTML 演示 / 流程图 / 可点原型

| 资产 | 路径 | 说明 |
| --- | --- | --- |
| 资料导航入口 | `知爻/FXplanner/00_资料导航/03_HTML演示与流程图/`（符号链接） | README 要求：**运行请用原路径**，避免相对资源坏链 |
| 业务流程图 V2.1 | `知爻/FXplanner/FXplanner_业务流程图_V2.1_原型节点状态更新.html` | 与 V2.1 断点清单配套 |
| 系统化免登录演示 | `知爻/FXplanner/outputs/FXplanner_V2_系统化免登录交互演示/` | 导航推荐入口之一 |
| PEN 严格还原 / 中文关键链路 / V2.2 双语场景等 | `outputs/FXplanner_PEN严格还原_…`、`…V2_中文关键链路_…`、`…业务场景流转原型_V2.2_…`、`…业务流程图_V2.2_中文` | HTML 交付族 |
| MVP 包内 index | `…/MVP功能模块&业务逻辑&专业术语/index.html`（知爻 / REBUILD / NEW 均有） | 模块文档浏览壳 |
| 业务建模图册 | `知爻/FXplanner/MVP…/19_业务建模图册.html` + `建模图源/` | **仅资料库有**；REBUILD 缺 |
| 泳道 / 页面流转 | `FXplannerREBUILD/docs/业务逻辑泳道图.{drawio,png}`、`全栈页面流转图.drawio`（NEW 同源） | 工程 docs 内的实现侧流程图 |
| Kimi 流程图调试页 | `知爻/FXplanner/FXplanner 流程图显示问题 - Kimi.html` + `_files/` | 排障残骸，非产品真源 |
| 旧栈邮件登录原型 | `Code/Project/FXplanner-V1.2.0/docs/prototype-email-login.html` | 旧栈 |

### 1.4 截图 / 渲染 / 验收视觉

| 目录 | 用途 |
| --- | --- |
| `知爻/FXplanner/outputs/MVP模块Word/原型截图` | Word 交付配图 |
| `outputs/MVP用户原型_20260908/截图`、`模块重排_20260907/截图` | 用户原型 / 重排证据 |
| `outputs/审查清单复核_20260920/原型证据` | 审查证据 |
| `outputs/render_*`、`render_native_*` | 渲染输出族 |
| `outputs/原型一致性审查_20260906/` | 业务逻辑 vs 原型一致性审查 |
| `Code/Project/FXplanner(-V1.2.0)/design/login-*.png` 等 | 旧登录预览 |

---

## 2. 功能 / 模块设计文档

### 2.1 MVP 功能模块包（核心）

**完整包（权威）**：`/Users/kyle/Documents/工作/知爻/FXplanner/MVP功能模块&业务逻辑&专业术语/`

| 编号 | 文件 | 要点 |
| ---: | --- | --- |
| 00 | `00_MVP_PRD.md` | 总规则表 + 模块索引；声明 16–18 与 01–15 共同组成 MVP PRD |
| 01–12 | `*_待确认.md` / 定稿 md + 配套 docx | 首次设置、录入、首页、账户、汇率、计划、分批、提醒、更正、使用、成本/收益报告 |
| 13–15 | 功能清单 / 业务逻辑清单 / 专业术语 | 横切清单；**15 术语为口径锁** |
| 16–18 | 时序 / 领域模型 / **实体状态机** | 开发对齐用状态 code；UI 标签另说 |
| 19 | `19_业务建模图册.html` + `建模图源/` | 离线图册 |

**REBUILD 副本**：`FXplannerREBUILD/docs/MVP功能模块&业务逻辑&专业术语/`  
仅有 **01–15 的 md（多数更短）+ V2.4/V2.5 pen + index.html**。  
**缺失**：`00_MVP_PRD`、全部 docx、`16–19`、`建模图源`、V2.0 pen。

**NEW 副本**：与 REBUILD 该目录同构（2026-09-24 冻结）。

**旧栈旁路**：`Code/Project/FXplanner-V1.2.0/MVP功能模块&业务逻辑&专业术语/` 亦有 V2.0/V2.4/V2.5 与 00 等——**不要与 REBUILD 混用为工程 SoT**。

### 2.2 其它需求 / 评审 / 断点

| 文档 | 路径 | 角色 |
| --- | --- | --- |
| 0902 评审与 9 月底 MVP 建议 | `知爻/FXplanner/FXplanner_0902评审复核与9月底MVP建议_本地审阅稿_20260903.docx` | 评审决策 |
| 业务交互流程与断点 V2.0 / V2.1 | 同目录 docx；V2.1「原型节点状态更新」 | 断点清单 |
| PRD V1.1.2 docx | `知爻/FXplanner/FXplanner_PRD_V1_1_2.docx` + 导航分类 | **旧代 PRD** |
| PRD V4.3 docx | `00_资料导航/01_需求与评审文档/`（及 outputs 审查用 txt） | 更早产品 PRD |
| 重构前资料盘点 | `FXplanner_重构前资料盘点_20260829.md` | 历史索引 |
| 资料导航 README | `00_资料导航/README.md` | 分类入口；**不自动认定最新版** |
| REBUILD 开发计划 | `FXplannerREBUILD/docs/开发计划/MVP开发计划.md` | 工程排期（2026-11-03 有本地更新） |
| NEW learning-notes | `FXPlanner-new/docs/learning-notes/*.md` | **领域概念纠偏笔记**；**REBUILD 未拷贝** |
| 线上链路核验 | `outputs/线上MVP链路核验_20260920/` | 验收用例 |
| 审查清单复核 | `outputs/审查清单复核_20260920/` | 审查 |

### 2.3 Agent 设计

| 资产 | 路径 | 锁什么 |
| --- | --- | --- |
| Agent PRD V0.2 | `知爻/FXplanner/FXplanner_MVP_Agent_PRD_V0.2.md` | 报告 Agent 职责、Harness、生命周期×报告类型、禁止模型写账本 |
| Agent 提示词 V0.1 | `…/FXplanner_MVP_Agent设计与系统提示词_V0.1.md` | 早期提示词基线；V0.2 声明替代契约 |
| 第一阶段设计包 | `知爻/FXplanner/outputs/Agent第一阶段设计_20260923/`（与 `FXPlanner-new/Agent第一阶段设计_20260923.zip` **同尺寸 95995**） | `01` 入口、`02` 接口与状态约束、`03` 验收交接；`prompts/`、`contracts/`（openapi + schema）、`examples/`、`validation/` |
| REBUILD 运行时 prompt | `FXplannerREBUILD/services/chat/src/ai/prompts/system-prompt.ts` | **已实现**助手提示；需与 V0.2/stage1 对照差距 |

### 2.4 旧栈 PRD / 验收 / 小程序范围

| 资产 | 路径 | 说明 |
| --- | --- | --- |
| PRD V1.2 / 纠偏验收 | `Code/Project/FXplanner-V1.2.0/docs/PRD_V1_2_*`、`PRD_V1_2_CORRECTION_VALIDATION.md` | 旧栈规格 |
| PRD V6 渲染过程 | `Code/Project/FXplanner/.codex-tmp/prd-v6/` 等 | 大量渲染缓存；Agent PRD 曾引用但「源码未提交」 |
| 小程序 SCOPE | `Code/Project/FXplanner小程序/SCOPE.md` | 轻量端边界；API 叙事仍偏旧 FastAPI——**上线后对接 REBUILD 时要重写依赖表** |
| BP Step0 原型事实 | `凯衍磁缘/02_FXplanner/Step0_原型事实清单.md` | 基于 **旧 Vue README 2026-04** 的融资事实清单；**不是**当前 REBUILD 工程事实 |

### 2.5 工程变更验收（实现侧约定痕迹）

`FXplannerREBUILD/changes/*/` 下大量 `验收记录.md` / `人工验收用例.md`（auth、onboarding、plan、usage、rate、AI…）。  
性质：**实现验收**，不是产品 Pencil；MVP 对账时与 E2E `e2e/modules` 一起看。

---

## 3. 约定 / 锁点清单（路径 + 一句话）

### 3.1 产品业务约定（规格层）

| 约定主题 | 权威路径 | 锁住什么 |
| --- | --- | --- |
| MVP 总规则 | `知爻/…/00_MVP_PRD.md` | 首次只选地区+本位币；目标∥计划；单笔 A→B；历史成本不随设置折算；停止报告含零使用 |
| 术语口径 | `…/15_专业术语清单.md`（**知爻完整版**） | 默认/原规划/成本来源币；分配=earmark；FIFO；备齐/完成/停止/后继计划等白话定义 |
| 业务计算与流程 | `…/14_业务逻辑清单.md` | 分配上限公式；分批 安心/均衡/主动；提醒合并；更正影响链 |
| 状态机 | `…/18_实体状态机.md` | OTP/会话/首次草稿/计划 ACTIVE·COMPLETED·CANCELLED·STOPPED；本位币变更停旧建新等**禁止迁移** |
| 领域实体 | `…/17_领域模型与实体定义.md` | E01–E31 逻辑身份与不变量（非物理表） |
| Goal vs Plan 等纠偏 | `FXPlanner-new/docs/learning-notes/*.md` | 分配非转账；本位币无余额；买入≠使用；定盘价 vs OHLC 等 |
| 产品定位话术 | 合规报告 + Agent PRD | 成本规划工具；不预测涨跌；不经手资金；不撮合 |

### 3.2 金额 / 汇率 / 币种（工程 SoT）

| 约定主题 | 权威路径 | 锁住什么 |
| --- | --- | --- |
| 15 币种常量 | `FXplannerREBUILD/packages/money/src/currencies.ts` | HKD USD GBP AUD CAD CNY JPY EUR SGD NZD TWD CHF KRW THB MYR；顺序=sortOrder |
| 金额舍入 | `packages/money/README.md` + `round.ts` | 十进制全精度；最终按币种精度 **ROUND_HALF_UP 一次**；正数舍入为 0 拦截；单笔上限 1e11 |
| 汇率精度 | `packages/money/src/rate.ts` | 展示口径「1 外币 = X 本位币」；汇率固定 **8 位** |
| 买入互算 | `packages/money/src/calc.ts` | `receivedAmountOf` / `impliedRate` / `finalAmountOf` |
| 目录与共享类型 | `FXplannerREBUILD/AGENTS.md` | 文件落点铁律；共享类型只从 OpenAPI 生成；money 禁止 IO |

### 3.3 状态 / 数据字段（实现现状）

| 约定主题 | 权威路径 | 锁住什么 |
| --- | --- | --- |
| 计划 status 字符串 | `services/chat/prisma/schema.prisma`（Plan 注释） | `ACTIVE` / `COMPLETED` / `CANCELLED`（注释未写 STOPPED——**与状态机 SM04 的 STOPPED 需产品+工程对齐确认**） |
| 其它 status | 同 schema | 更正 `APPLIED` 等；提醒 `PENDING` 等——以 schema + 模块代码为准 |
| Agent 报告阶段 | Agent PRD V0.2 + stage1 `02_接口与状态约束.md` | draft/active/completed/cancelled/stopped × PLANNING/PROGRESS/REVIEW/STOP_SUMMARY；HTTP×delivery_status |

### 3.4 合规文案

| 约定主题 | 权威路径 | 锁住什么 |
| --- | --- | --- |
| 定性与命名红线 | `Code/Project/FXplanner/docs/COMPLIANCE_RESEARCH_2026-06.md` | 禁止「金融投顾/外汇咨询」等包装；营销禁「外汇/货币兑换/理财」等字样（报告结论）；工具+信息展示 |
| 前端封杀词 lint | `Code/Project/FXplanner/scripts/compliance-lint.mjs` | 收益/盈利/赚/预测/抄底/最佳时机/投资建议/看涨看跌/稳赚/保本/择时及方向建议句式；disclaimer 仅窄豁免 |
| REBUILD | （尚无同名 lint） | **需移植规则到 Nest/Next**，见整合简报 P2 |

### 3.5 UI / 工程结构约定

| 约定主题 | 权威路径 | 锁住什么 |
| --- | --- | --- |
| 组件分层 | `AGENTS.md` | `business → base → ui` 单向 |
| changes 文档位置 | `AGENTS.md` | 需求/方案/验收只进 `changes/<功能>/` |
| AI 禁止起服 | `AGENTS.md` | 禁止 AI 直接 `dev` / `compose up` |
| 小程序边界 | `FXplanner小程序/SCOPE.md` | 快录+查看+分享；不做分批配置/复杂台账/支付（兑换码）等 |

### 3.6 Agent 行为约定

| 约定主题 | 权威路径 | 锁住什么 |
| --- | --- | --- |
| 模型不算账 | Agent PRD V0.2 | 业务服务冻结快照；模型只解释；不能写计划/分配/使用 |
| 请求权威字段 | stage1 `02_接口与状态约束.md` | 客户端不提交金额/持仓作权威；Idempotency-Key；版本冲突 409 |
| 执行门控 | 同上 ExecutionGate | started/unknown 禁止新候选；语义审计 reject 即丢草稿 |
| 金融边界 | Agent PRD §期货/教育 | 不预测即期、不承诺节省、不下单 |

---

## 4. 冲突与漂移（同主题多源时跟谁）

| 主题 | 源 A | 源 B | 判断 |
| --- | --- | --- | --- |
| MVP 模块 md 篇幅 | `知爻/FXplanner/MVP…` 更长（多数文件） | `REBUILD/docs/MVP…` 明显缩水 | **规格以知爻完整包为准**；REBUILD 仅作工程内只读缓存，合并前勿盲覆盖代码假设 |
| 术语「本位币」 | REBUILD `15` 仍写旧「统一计算成本的货币」短表 | 知爻 `15` 拆成默认/原规划/成本来源币等 | **知爻更新**；REBUILD 术语过时 |
| 状态 STOPPED | `18_实体状态机` 明确 STOPPED | Prisma Plan 注释写 ACTIVE/COMPLETED/CANCELLED | **待工程确认是否已用字符串 STOPPED 或另字段**——上线前必须对齐 |
| Pencil 最新 | V2.5 @ 知爻/REBUILD | 导航仍链 V1.2/V2.0–V2.3；部分 **断链** | 交互以 **V2.5**；修导航或忽略断链，勿打开死链当现行稿 |
| V2.0 pen | 知爻 MVP 包有 | REBUILD 无 | 需要双语全量画板时回资料库 |
| Agent 设计 | 知爻 md + outputs 解压包 | NEW 仅 zip；REBUILD 仅 `system-prompt.ts` | 规格在知爻；实现差距在 REBUILD AI 模块 |
| learning-notes | NEW `docs/learning-notes` | REBUILD **无** | 建议拷进 REBUILD `docs/learning-notes`（P1） |
| 产品完成度叙事 | 09-17 mvp-completion「M7–M11 未开工」 | 当前 REBUILD 代码已有 usage/reminder/report… | **代码为准**（整合简报已写） |
| 合规 lint | 旧 Vue 仓有脚本 | REBUILD 无 | 规则有效，实现要重写 |
| 线上事实 / 域名 | 凯衍 `Step0_原型事实清单`（Vue app.fxplanner.cn） | REBUILD 部署尚未等同 | BP 叙事 ≠ 新栈现状 |
| 小程序 API | SCOPE 写 `/api/v1/...` FastAPI 味 | REBUILD Nest `/api` | 后置对接时重订契约 |
| 历史 PRD V1.1.2 / V4.3 / V6 | 旧文档与 codex 渲染 | 2026-09 MVP 包 | **MVP 以 00+01–18 为准**；旧 PRD 仅追溯 |

---

## 5. 建议的「设计 SoT」分层（不改仓，只约定用法）

```
交互原型 SoT:     知爻/FXplanner/MVP…/V2.5.pen （REBUILD 有副本可开）
产品规格 SoT:     知爻/FXplanner/MVP…/00–18（完整）
Agent 规格 SoT:   知爻 Agent PRD V0.2 + outputs/Agent第一阶段设计_20260923
工程约定 SoT:     FXplannerREBUILD/AGENTS.md + packages/money + prisma
合规话术 SoT:     Code/Project/FXplanner/docs/COMPLIANCE_* （摘录进 REBUILD docs/compliance 后工程引用摘录）
商业叙事:         凯衍磁缘/02_FXplanner （非 UI/状态机）
```

拷贝建议（与整合简报 §5 一致，设计侧强调）：

- P1：知爻缺失篇 `00`、`16–19`、完整 `15` → REBUILD `docs/MVP…` 或 `docs/archive-from-知爻-FXplanner/`
- P1：NEW `learning-notes` → REBUILD `docs/learning-notes`
- P1：Agent 包 → `docs/agent/`
- P2：合规封杀词 → `docs/compliance/` + 新 lint change

---

## 6. 本盘点未做 / 边界

- 未逐屏打开 Pencil 画板核对与前端路由像素级一致。  
- 未全文 diff 每一份「知爻 md vs REBUILD md」（仅抽样：术语 15 已确认漂移；尺寸表见上）。  
- 未在 Figma 账号侧再搜（本地无链接即记「无本地 Figma 源」）。  
- 未修改/删除任何原型或规格文件。

---

*本文件路径：`/Users/kyle/Documents/工作/知爻/FXplannerREBUILD/docs/NOMI-FX-DESIGN-INVENTORY-20261103.md`*  
*关联：`docs/NOMI-FX-CONSOLIDATION-20261103.md`*

---

## 7. 导入落地

结构化副本：[`imported-20261103/README.md`](./imported-20261103/README.md)（2026-11-03）。此后打开规格/原型优先走该目录地图；原路径仍保留。
