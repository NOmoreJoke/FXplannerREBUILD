# FXplanner 历史有用材料结构化导入

- 日期：2026-11-03（Asia/Shanghai）
- 目标仓：`FXplannerREBUILD`
- 动作：**仅复制**；未删除、未移动源目录；未把旧 Vue/FastAPI 源码并进 monorepo
- 依据：`docs/NOMI-FX-CONSOLIDATION-20261103.md` + `docs/NOMI-FX-DESIGN-INVENTORY-20261103.md`

## 目录地图

| 目录 | 内容 | 约文件数 |
| --- | --- | ---: |
| `product-specs/` | 知爻完整 MVP 规格 md/docx/建模图源；`gaps/`=REBUILD 缺篇 | 140 |
| `prototypes/` | Pencil V1.2–V2.5、HTML 演示、断链说明 | 21 |
| `agent/` | Agent PRD V0.2/V0.1 + `stage1-20260923/` 解压包 + zip | 40 |
| `business/` | BP_主源 + Step0–6 等 md；产出 html/docx/小 pptx；大 pptx 仅索引 | 29 |
| `compliance/` | COMPLIANCE 调研 + 旧 lint 脚本（参考） | 4 |
| `env-samples/` | 仅 `.env*.example`（可提交） | 6 |
| `local-secrets/` | 真实 `.env.local` 备份（**gitignored**） | 8 |
| `from-FXPlanner-new/` | learning-notes + Agent zip | 13 |
| `reviews/` | 资料导航 README、评审/断点/旧 PRD 摘录 | 19 |
| `miniprogram/` | 仅 `SCOPE.md` | 2 |
| `ARCHIVE-INDEX.md` | 故意未拷路径 | — |

**合计（含本 README 等）约 283 个文件，目录体积约 103M。**

## 怎么用（SoT）

1. **交互原型**：`prototypes/pen/FXplanner-V2.5-MVP用户交互原型.pen`
2. **产品规格**：`product-specs/_from-知爻/` + `gaps/`（00、16–19、完整 15）
3. **Agent**：`agent/FXplanner_MVP_Agent_PRD_V0.2.md` + `agent/stage1-20260923/`
4. **工程约定**：仍以仓根 `AGENTS.md` + `packages/money` 为准（未改）
5. **合规**：`compliance/` → 规则移植到新 lint（另开 change）
6. **商业**：`business/BP_主源.md`；路演大文件见 `business/产出-index/`

## 相对 REBUILD 已有 docs 的策略

- **未覆盖** `docs/MVP功能模块&业务逻辑&专业术语/` 内已有 01–15 缩水 md / V2.4·V2.5 pen。
- 完整规格放在 `imported-20261103/product-specs/`，避免盲覆盖工程内缓存。
- REBUILD 根已有 `.env.local` 三件套；`local-secrets/` 另存 NEW + 当日快照。

## 密钥

- `local-secrets/` 已加入 `.gitignore`。
- 仓内原有 `.env` / `.env.*` 规则继续生效。
- **不要** `git add -f` 本目录下任何真实 env。

## 相关文档

- [`../NOMI-FX-CONSOLIDATION-20261103.md`](../NOMI-FX-CONSOLIDATION-20261103.md)
- [`../NOMI-FX-DESIGN-INVENTORY-20261103.md`](../NOMI-FX-DESIGN-INVENTORY-20261103.md)
- [`ARCHIVE-INDEX.md`](./ARCHIVE-INDEX.md)
