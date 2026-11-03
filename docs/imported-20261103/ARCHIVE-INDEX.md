# 未拷进 import 的路径（留在原地）

原则：大体积、旧栈源码、交接介质、工具缓存 **只索引不复制**。

| 路径 | 原因 |
| --- | --- |
| `/Users/kyle/Documents/工作/知爻/FXPlanner-new`（除已拷 learning-notes / Agent zip / env） | 旧 remote 冻结仓；代码与 REBUILD 同源，勿双写 |
| `/Users/kyle/Documents/工作/知爻/交接/FXPlanner-new`（`*.bundle` / `*.zip` / SHA256SUMS / review） | 交接审计介质；体量大 |
| `/Users/kyle/Code/Project/FXplanner` 的 `src/` `backend/` `node_modules` 等 | 旧 Vue+FastAPI；**禁止并进 monorepo** |
| `/Users/kyle/Code/Project/FXplanner-V1.2.0` 除已拷 pen/部分 PRD | 旧栈快照；源码不合并 |
| `/Users/kyle/Code/Project/FXplanner-worktrees/*` | worktree 重复 |
| `/Users/kyle/Code/Project/FXplanner小程序` 除 `SCOPE.md` | 独立小程序仓；后置对接 |
| `知爻/FXplanner/outputs/` 大量 render_* / 截图 zip / Word 打包 zip | 过程证据；规格真源已在 product-specs；需要时回原路径 |
| `知爻/FXplanner/00_资料导航/` 内符号链接树 | 多为断链或指向原路径；已拷 README + 断链说明 |
| `凯衍磁缘/02_FXplanner/产出` 超大 pptx / pdf | 见 `business/产出-index/` 与 `BINARY-INDEX.md` |
| `Documents/Codex/*fxplanner*` | 过程归档 |
| 微信 Containers / `.gstack` / `.claude` / `.zcode` 缓存 | 工具缓存 |

交接包速查：

```
/Users/kyle/Documents/工作/知爻/交接/FXPlanner-new/
```
