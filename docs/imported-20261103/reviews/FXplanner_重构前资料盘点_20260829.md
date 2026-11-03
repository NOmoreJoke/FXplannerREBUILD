# FXplanner 重构前资料盘点

## 核心结论

- 当前目录是独立交付资料包，不是源码 Git 仓库。
- 盘点时规模：`205.48 MiB / 1,031 个既有文件 / 56 个目录（含根目录）`；写入本报告后为 1,032 文件。
- 内容混有：历史 PRD、规则文档、多代 Pencil、静态演示、生成脚本、数据 fixtures、验收截图与缓存。
- 不宜在原目录直接覆盖重构：先冻结旧资料，新建独立 `vNext/`。
- 当前不存在可无条件继承的单一事实源；PRD、原型、静态演示、源码实现必须分层引用。
- 本报告只审计当前交付资料包；源码 Git、数据库迁移、API、运行时和部署状态尚未审计，不能据此宣称“整体重构已具备开工条件”。

## 资料分层

| 层级 | 当前候选 | 判定 | 重构用途 |
|---|---|---|---|
| 历史产品定义 | `FXplanner_PRD_V1_1_2.docx` | 文件名 V1.1.2；内部标题 V1.1.1；276 页仅为 OOXML 元数据 | 版本冲突待核；只抽取需求 |
| 更早 PRD | `FXplanner 产品需求文档（PRD）V4.3.docx` | 2026-07-03；72 页 | 冲突追溯/归档 |
| 业务规则 | `FXplanner_业务交互流程与断点清单_V2.1_原型节点状态更新.docx` | 92 项断点、127×2 原型映射 | 拆成规则、状态机、验收合同 |
| Agent/数据规则 | `outputs/*_V1_1.docx` 五件套 | 业务链路、UIX、数据、WBS、门禁 | 仅提取已证实合同；排期/WBS 重做 |
| 中文流程拓扑参考 | `FXplanner-V2.3-流程图驱动中文界面流转.pen` | 7 场景、33 个 CN 界面、26 次迁移（24 主线+2 分支）、52 个连接图形（26 线体+26 箭头） | vNext 信息架构/异常路径参考 |
| 最新双语拓扑 | `FXplanner-V2.3-流程图驱动中英界面流转.pen` | 旧双语全量拓扑分支 | 国际化参考；不作为中文主线 |
| 按 mtime 最新 Mock | `outputs/FXplanner_V2_系统化免登录交互演示/index.html` | 2026-08-29；浏览器内存 Mock；无真实 API/模型/交易 | 交互意图参考，不作业务/视觉真源 |
| 数据样本 | `outputs/fixtures/`、`FXplanner_数据源实测Fixtures_20260810.zip` | 6 个来源：5 个采集/合同校验通过，HKMA 为超时失败占位；另有 1 manifest | 仅作 schema/适配器测试样例 |
| 生成工具 | 根目录 5 个 `.py` | 存在旧事实、硬编码路径、不可复现风险 | 默认隔离；验证后才可晋级 vNext 工具 |
| 验收缓存 | `.playwright-cli/`、`output/playwright/`、`outputs/render_*` | 截图、YAML、PDF、日志 | 不进入新基线 |

## 版本关系

| 资产族 | 保留入口 | 归档版本 | 备注 |
|---|---|---|---|
| PRD | `FXplanner_PRD_V1_1_2.docx` | `PRD V4.3` | 两者均为历史输入，非 vNext 真源 |
| 业务断点 | `V2.1_原型节点状态更新.docx` | `V2.0`、`outputs/...V1_0` | `project-preview-9b8cc0.docx` 与 V2.0 SHA-256 完全相同 |
| Pencil 中文主线 | `V2.3-流程图驱动中文界面流转.pen` | V1.2.0、V2.0、V2.1、V2.2 | `.pen` 为静态设计，不含运行时交互定义 |
| 双语拓扑 | `V2.3-流程图驱动中英界面流转.pen` | V2.0、V2.1、V2.2 | 中文重构首期可不继承 |
| 流程图 HTML | `outputs/FXplanner_业务流程图_V2.2_中文/` | Kimi V1.0、V2.1 HTML、ZIP | Kimi HTML 与 `_files/` 必须成对保留 |
| 启动交付包 | `outputs/*_V1_1.docx` | `*_V1_0.docx`、V1.1 ZIP | ZIP 是快照，不是编辑真源 |

## 遗漏资产补录

| 资产 | 类型 | 当前定位 |
|---|---|---|
| `artifact.md` | V2.1 交付契约 | 历史验收约束；非产品需求 |
| `FXplanner-V1.2.0-完整验收原型.backup.pen` | 旧备份 | 39 个顶层 frame；只归档 |
| `outputs/FXplanner_PEN严格还原_免登录交互演示/` | 视觉还原演示 | 大型内嵌静态稿；非运行时实现 |
| `outputs/FXplanner_V2_中文关键链路_免登录交互演示/` | 关键链路演示 | 由 V2.0 PEN 派生；14 个关键帧 |
| `outputs/FXplanner_V2_系统化免登录交互演示/` | 系统化 Mock | mtime 最新；未发现对应可复现生成器 |
| `outputs/FXplanner_免登录交互演示/` | 更早演示 | 旧分支；归档 |

## 生成器可信度

| 脚本 | 已知输入/输出 | 风险 | vNext 处理 |
|---|---|---|---|
| `build_fxplanner_delivery.py` | 生成 V1.1 五件套 | 仍嵌入“35 状态”和旧 hash `640a8eb2…` | 遗留隔离；禁止直接重跑 |
| `build_strict_html_prototype.py` | V2.0 PEN → 14 帧演示 | 硬编码本机 Codex cache 的 Lucide 路径 | 先消除环境依赖再复现 |
| `build_business_flow_docx.py` | Markdown → V1.0 流程 DOCX | 输入/输出版本已落后 | 只保留生成思路 |
| `update_flow_docx_v21.py` | V2.0 → V2.1 DOCX | 只更新原型节点状态；不证明实现 | 归档 |
| `capture_data_fixtures.py` | 外部来源 → fixtures | 网络、时间、许可、接口漂移 | 重做来源准入与可重复测试 |

## 清理候选

| 状态 | 范围 | 精确盘点值 | 风险/前置条件 |
|---|---|---:|---|
| 冻结后候选 | `.DS_Store`、`__pycache__/*.pyc` | 10 文件 / 0.1918 MiB | manifest 后清理 |
| 冻结后候选 | `.playwright-cli/` | 159 文件 / 2.3505 MiB | 含门禁截图/YAML；先提取最终证据白名单 |
| 冻结后候选 | `outputs/render_*`、`outputs/font-test*` | 418 文件 / 102.7009 MiB | 先保留最终门禁记录与代表性渲染 |
| 冻结后候选 | `project-preview-9b8cc0.docx` | 1 文件 / 0.1823 MiB | 内容完全重复，但 Playwright YAML 存在路径引用 |
| 可归档 | `output/playwright/` | 15 文件 / 1.9553 MiB | 保留最终关键截图即可 |
| 可归档 | 所有旧版 `.pen`、`*_V1_0.docx`、旧 ZIP | 待 manifest 精确分组 | 必须保留版本追溯 |
| 禁止直接删 | `FXplanner 流程图显示问题 - Kimi_files/` | 6.46 MiB | V1.0 HTML 的配套依赖 |

上述四类“冻结后候选”去重合计：`583 文件 / 110,511,821 bytes / 105.3923 MiB`。未执行任何删除/移动。

重复证据：`project-preview-9b8cc0.docx` 与 `FXplanner_业务交互流程与断点清单_V2.0.docx` 的 SHA-256 均为 `58aae27bdde44937d4c93e084d7a43695d462c20fa99562f35bb77e739676aaa`。

## 权威性与冲突账本

| 冲突 | 当前证据 | 状态 |
|---|---|---|
| PRD V1.1.2 vs 内部 V1.1.1 | 文件名与 core title 不一致 | 阻断新 PRD 继承 |
| 35 / 39 / 49 / 127 / 33 界面口径 | 分别来自旧生成器、backup PEN、V1.2 审计、双语画板、中文流程拓扑 | 必须按资产类型重命名指标 |
| 静态 PEN vs 交互演示 vs 实现 | PEN 未发现运行时交互字段；HTML 为 Mock；源码未审 | 禁止互相替代证据 |
| 最新 mtime vs 权威真源 | 系统化 Mock 最新，但无可复现生成器 | 只标 `latest_by_mtime` |
| 数据样本 vs 生产数据源 | fixtures 仅合同证据；HKMA 失败 | 来源准入未完成 |

vNext 必须建立：`资产 → 事实主张 → 证据 → 冲突 → 决策状态 → vNext 去向` 矩阵。

## vNext 目录建议

```text
vNext/
├── 00-index/              # 权威索引、决策账本、术语表
├── 01-product/            # 产品边界、角色、场景、PRD
├── 02-domain/             # Goal/Holdings/Lots/Quote/Fee/Settlement
├── 03-rules/              # FIFO、费用、日期、降级、状态机
├── 04-data-contracts/     # Provider、Canonical Schema、证据等级
├── 05-agent/              # 输入输出 JSON、工具权限、Guardrail、Eval
├── 06-ux/                 # IA、页面合同、交互状态、原型
├── 07-engineering/        # 架构、API、存储、任务、可观测性
├── 08-acceptance/         # RTM、测试、门禁、发布证据
└── tools/                 # 可复现生成/校验脚本

archive/2026-pre-refactor/ # 当前资料冻结快照
tmp/                       # 渲染、截图、浏览器过程文件；不入基线
```

## 重构起点

1. 待重新确认候选边界：只做换汇规划；不代客交易、不预测汇率、不把未知费用视为 0。
2. 建立唯一索引：每类事实只允许一个权威文件；缺失/冲突即阻断。
3. 先重做领域合同：目标净到账、持仓/FIFO、报价/费用、结算、事实快照。
4. 再定义 Agent：LLM 负责提取/询问/解释；确定性引擎负责金额、FIFO、费用、日期。
5. 再做 UX：从任务闭环和异常恢复生成页面，不从旧画板数量反推需求。
6. 最后落工程：API/DB/任务/权限/审计/测试均追溯到规则 ID。

## Phase 0 完成门槛

- 当前资料包生成全量 `path/size/mtime/SHA-256` manifest，并记录总清单 hash。
- 源码仓库冻结明确 commit；独立审计代码、迁移、API、运行时、测试与部署证据。
- 建立权威索引、术语表、决策账本、冲突账本；冲突清零或显式豁免。
- 明确重构目标版本、首期用户/地区/币种、代码继承范围、历史数据迁移、数据源准入、合规/发布边界。
- 建立规则 ID → API/DB/页面/测试的 RTM 与 fail-closed 验收合同。
- 审计敏感数据/凭证、第三方 JS/字体/外部链接的许可与可持续性。本轮仅做文件名扫描，未发现 `.pem/.key/.p12/.env/*secret*/*credential*` 文件；不等于内容级无敏感信息。
- 先归档最终证据白名单，再处理 583 个清理候选。

## 首个待确认决策

是否采用：`旧资料只读冻结归档 + 新建 vNext 独立重构区`。
