# FXplanner 本地多仓盘点与整合简报

- 日期：2026-11-03（Asia/Shanghai）
- 机器：Kaiming Mac `468a331a-9f27-4f92-8a52-56286224483d`
- 原则：**单一事实源 = `FXplannerREBUILD`**；本简报只做盘点与合并建议，**未删除任何文件夹，未改应用代码**。
- 检索范围：`mdfind` + `find` 覆盖 `/Users/kyle` 下名称含 FXplanner / FXPlanner / fxplanner / NOmoreJoke 的目录；忽略 `node_modules` 内容倾倒与微信缓存副本作为「可执行根」。

---

## 1. 结论先行

| 项 | 结论 |
| --- | --- |
| 最新可执行仓 | `/Users/kyle/Documents/工作/知爻/FXplannerREBUILD` |
| Git remote | `https://github.com/NOmoreJoke/FXplannerREBUILD.git` |
| 当前分支 / tip | `dev` @ `1d0ace2`（2026-10-22）`chore(deps): 补齐 isolated linker…`；比 `FXPlanner-new` tip `2f5f649` **多 2 个提交**（安全整改 + deps） |
| 栈 | Bun + Turbo monorepo；Next.js `clients/chat-web` + NestJS `services/chat` + Prisma/PostgreSQL + Playwright/Vitest |
| 相对旧 Vue/FastAPI 仓 | **另起炉灶的重建**，不要把旧栈当主线合并进 REBUILD |
| 快速上线主路径 | 在 REBUILD 上补齐「可演示闭环 + 生产 env + 冒烟/E2E」，而不是再开第 4 个仓库 |

**注意**：2026-09-17 的 `changes/mvp-completion/审查报告与开发计划.md` 写「M7–M11 未开工」——**已过时**。当前 `services/chat/src` 已含 `usage` / `reminder` / `report` / `correction` / `data-request`（合计数千行）且挂在 `app.module.ts`；E2E 也有 `11-plan-usage` / `11-reminders` / `11-reports` / `11-correction` / `12-account-data` 等。整合与排期应以**当前代码树**为准，审查报告仅作历史缺口叙事。

---

## 2. 库存总表（项目根）

| # | 绝对路径 | Git remote / 分支 / 最近提交 | 栈 | 角色 | MVP 完整度（证据） | 相对 REBUILD 的独特价值 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `/Users/kyle/Documents/工作/知爻/FXplannerREBUILD` | `NOmoreJoke/FXplannerREBUILD`；`dev`；2026-10-22 `1d0ace2` | Bun/Turbo/Next/Nest/Prisma | **Canonical rebuild / 主工程** | Auth/OTP、onboarding、账户、买入、计划、分批、使用、更正、提醒、报告、数据请求、AI chat、market；`infra/compose` + `deploy.sh` + GH Actions；`.env.local.example` 齐全；本地有 `node_modules` | 本体；README 仍写「骨架」但业务模块已远超骨架 |
| 2 | `/Users/kyle/Documents/工作/知爻/FXPlanner-new` | `jiangxiaoyu66/FXPlanner-new`；`dev`；2026-09-24 `2f5f649` | 同 #1（历史同源） | 交接前主仓快照 / 旧 remote | 与 REBUILD 在 `2f5f649` 对齐；**缺** REBUILD 的安全/deps 两提交；目录无完整 `node_modules`（约 30M） | **本地 `.env.local` 三件套**（根/web/chat）；`Agent第一阶段设计_20260923.zip`；`polygrapher/` 代码地图（生成物） |
| 3 | `/Users/kyle/Documents/工作/知爻/交接/FXPlanner-new` | `review/` 内仍指向 `jiangxiaoyu66/FXPlanner-new` @ `2f5f649`；另有 `.bundle` / `.zip` | 同 #2 | 交接包 + 可审阅解压树 | 与 #2 tip 同点；非日常开发根 | `FXPlanner-new-handover-20260924.{bundle,zip}` + `SHA256SUMS`；可作审计/回滚介质 |
| 4 | `/Users/kyle/Documents/工作/知爻/FXplanner` | 无 git | 文档/原型/脚本（非 app） | **产品资料库** | 不产出可部署二进制 | V2.x Pencil、MVP Agent PRD/提示词、0902 评审、`00_资料导航`、HTML 演示、`outputs/` 交付；**比 REBUILD/docs 多** `00_MVP_PRD`、`16–19` 建模、docx、V2.0 pen 等 |
| 5 | `/Users/kyle/Documents/凯衍磁缘/02_FXplanner` | 无 git | Markdown + BP 产出 | **商业计划 / 路演** | 非工程 | `BP_主源.md`、Step0–6、`产出/` 下 pitch/pptx/html；融资与对外叙事真源 |
| 6 | `/Users/kyle/Code/Project/FXplanner` | `NOmoreJoke/FXPlanner`；本地 `feature/prd-v1-review` 停在 `915ae2f`（2026-06-16）；另有大量 sprint 分支；worktree 链到 V1.2 | Vue3+Vite + FastAPI/DDD + Docker/1Panel | **旧一代 Web 产品**（曾部署叙事） | README 声称 Sprint R1–P4/F 完成、pytest 大量绿、compose 部署；与 REBUILD **栈不兼容** | 合规封杀词 lint、银行牌价抓取、billing/region_rules、PRD V6/合规调研、生产部署经验（1Panel）、设计 pen |
| 7 | `/Users/kyle/Code/Project/FXplanner-V1.2.0` | `NOmoreJoke/FXplanner-V1.2.0`；`feature/prd-v1-2-correction` @ `a0829f4`（2026-07-30） | 同 #6 血统的 V1.2 快照仓 | 旧栈 V1.2 纠偏快照 | 本地验收文档齐全；**未部署生产**（自述） | `PRD_V1_2_*`、纠偏验收、环境样例（`.env.production*`）、验收 pen |
| 8 | `/Users/kyle/Code/Project/FXplanner-worktrees/prd-v1-1-2-main` | 挂在 #6 的 git worktree；`main` `8b28d04` | 同 #6 | worktree：V1.2 merge 点 | 同旧栈 | 与 #6/#7 重复；勿当第二主仓 |
| 9 | `/Users/kyle/Code/Project/FXplanner-worktrees/prd-v1-1-2-refactor` | worktree；`c8cd8cd` | 同 #6 | worktree：重构分支 | 同旧栈 | 同上 |
| 10 | `/Users/kyle/Code/Project/FXplanner小程序` | `NOmoreJoke/FXplannerMiniProgram`；`main` `ef9c9d7`（2026-06-19） | 微信原生 TS 小程序骨架 | 旁路客户端 | 仅骨架 + `SCOPE.md`；未接新 Nest API | 小程序范围边界（做什么/坚决不做）；**上线后**再对接 REBUILD API |
| 11 | Codex/归档簇（摘要） | 多数无独立产品 remote | zip/pdf/md | **过程归档** | 不参与上线 | 源码冻结 zip（`915ae2f`/`c8cd8cd`/`8b28d04`）、PRD 渲染、Agent 审计笔记 |
| — | 微信 Containers 下 `.pen`、`.gstack`、`.claude` 缓存、`.zcode` memories | — | 缓存 | 忽略 | — | 有需要从 #4/#1 取正式副本 |

**体量参考（约）**：REBUILD 1.3G（含 deps）；旧 `Code/Project/FXplanner` 3.5G；资料库 `知爻/FXplanner` 581M；`FXPlanner-new` 30M；小程序 480K；BP 19M；交接 55M。

---

## 3. 仓库血缘（怎么「乱」起来的）

```
[旧产品线] NOmoreJoke/FXPlanner (Vue+FastAPI)
    ├─ Code/Project/FXplanner (+ worktrees)
    └─ 旁支快照 NOmoreJoke/FXplanner-V1.2.0
[小程序旁路] NOmoreJoke/FXplannerMiniProgram
[新栈] jiangxiaoyu66/FXPlanner-new  ──fork/迁仓──▶  NOmoreJoke/FXplannerREBUILD (dev 领先)
         └─ 交接 bundle/review 冻在 2026-09-24
[文档/BP] 知爻/FXplanner（资料） + 凯衍磁缘/02_FXplanner（商业）
```

- REBUILD README 仍自称「FXPlanner-new 骨架」、scope `@fxplanner-new`——命名债务，不影响「以 REBUILD 为 SoT」。
- `FXPlanner-new` 与 REBUILD **共享至 `2f5f649` 的历史**；之后只在 REBUILD 上前进。日常开发应 **停用 NEW 写代码**，避免双远程分叉。

---

## 4. 推荐单一事实源

**代码 + 部署 + 工程文档**：`/Users/kyle/Documents/工作/知爻/FXplannerREBUILD`（remote `NOmoreJoke/FXplannerREBUILD`，工作分支建议继续 `dev`）。

**产品规格辅源（只读引用，不改代码根）**：

- 功能/术语：优先 REBUILD `docs/MVP功能模块&业务逻辑&专业术语/`；缺篇时回 `知爻/FXplanner/MVP…`（尤其 `16–19`、docx、`00_MVP_PRD`）。
- Agent 设计：`知爻/FXplanner/FXplanner_MVP_Agent_*.md` + NEW 仓内 `Agent第一阶段设计_20260923.zip`。
- 商业叙事：`凯衍磁缘/02_FXplanner`。
- 合规/旧实现参考：`Code/Project/FXplanner/docs/COMPLIANCE_*`（**移植规则与文案，不移植 FastAPI 代码**）。

---

## 5. 建议合并 / 拷贝进 REBUILD（文件级）

> 执行时由工程 bot 做「复制到 `docs/` 或 `changes/` + 注明来源」；**不要**把旧 Vue/Python 树嵌进 monorepo。

| 优先级 | 源 | 目标（建议） | 说明 |
| --- | --- | --- | --- |
| P0 | `FXPlanner-new/.env.local` + `clients/chat-web/.env.local` + `services/chat/.env.local` | REBUILD 同路径（**gitignore，已有 example**） | NEW 有可跑本地密钥占位；REBUILD 目前仅 example。拷贝后人工核对，勿提交 git |
| P0 | （已在 REBUILD）`infra/compose/*`、`deploy.sh`、workflows | 保持 | 上线路径已具备；补齐服务器 `.env` 与镜像 tag 纪律即可 |
| P1 | `知爻/FXplanner/FXplanner_MVP_Agent_PRD_V0.2.md`、`…设计与系统提示词_V0.1.md` | `docs/agent/`（新建） | Agent 产品规格；对照已有 `services/chat/src/ai/prompts` |
| P1 | `FXPlanner-new/Agent第一阶段设计_20260923.zip` | `docs/agent/stage1-20260923/` 解压 | contracts/prompts/examples；与现 AI 模块对齐差距 |
| P1 | `知爻/FXplanner/MVP…` 中 REBUILD 缺失的 `00_MVP_PRD`、`16–19_*`、相关 docx | `docs/MVP功能模块&业务逻辑&专业术语/` 或 `docs/archive-from-知爻-FXplanner/` | 补齐建模真源；md 有差异时以「较新 mtime + 业务确认」为准，勿盲覆盖 |
| P2 | `凯衍磁缘/02_FXplanner/BP_主源.md` + `产出/` 最新 pitch | `docs/business/` 符号链接或拷贝索引 | 对外材料；工程仓只留索引以免膨胀 |
| P2 | `Code/Project/FXplanner/docs/COMPLIANCE_RESEARCH_2026-06.md` + `scripts` 合规思路 | `docs/compliance/` 摘录 + 新 `changes/compliance-lint` 方案 | 旧仓有 `lint:compliance`；REBUILD 需 **重写** 为 Nest/Next 文案门禁，不复制 Python |
| P3 | `FXPlanner-new/polygrapher/` | 可选 `docs/polygrapher-20260813/` 或忽略 | 过期代码地图（commit `97fd8aa`），价值低，可重新 `bun run docs:codemap` |
| P3 | 交接 `*.bundle` / `*.zip` | **留在交接目录**；在 REBUILD `docs/` 写一行索引路径 | 不拆进主仓 |

**明确不要合并进 REBUILD 源码树**

- `Code/Project/FXplanner` / `FXplanner-V1.2.0` / worktrees 的 `backend/`、`src/`（Vue）
- Codex zip 内整包源码（除非单文件对照）
- 微信缓存 `.pen`
- 小程序工程（独立仓；API 契约稳定后再接）

---

## 6. 建议归档 / 忽略（不删除，仅「停止当作主线」）

| 路径 | 处置 |
| --- | --- |
| `知爻/FXPlanner-new` | **只读冻结**；本地 env 迁走后不再 `bun` 开发；可改文件夹名加 `_ARCHIVED_20260924`（需你确认后由工程 bot 执行，本简报未改名） |
| `知爻/交接/FXPlanner-new` | 归档保管 |
| `Code/Project/FXplanner*`（含 worktrees、V1.2.0） | 旧栈只读参考 / 历史生产对照 |
| `Code/Project/FXplanner小程序` | 延后；SCOPE 保留 |
| `Documents/Codex/2026-07-*fxplanner*` | 归档 |
| `Library/.../WeChat.../FXplanner*.pen` | 忽略 |
| `.gstack` / `.claude` / `.zcode` / kimi sessions | 工具缓存，忽略 |

---

## 7. 务实 MVP 切割（「快速上线」）

对齐产品定位（成本规划、不预测涨跌、不经手资金）与 REBUILD 已实现主链。

### Must-have（上线门槛）

1. **注册/登录（密码 + OTP）** + 条款/年龄确认路径可用  
2. **Onboarding**：本位币、初始持仓入账、记账起点  
3. **汇率查询**（可用报价 + 过期行为明确）  
4. **账户余额 / 买入交易**（手续费三态）  
5. **换汇计划 + 分配 + 分批准备**  
6. **资金使用（M7）** —— 闭环「准备→使用→可完成」  
7. **首页可完成「建计划 / 录买入 / 看进度」** 无需进死胡同  
8. **生产配置**：`compose.prod` + 密钥（JWT/OTP/SMTP/DB）+ 健康检查 ` /api/health`  
9. **最小合规文案**：落地页与报告免责声明（可先手工固化，后续再上 lint）  
10. **冒烟**：`typecheck` + 关键 API/E2E 子集（auth、plan、transaction、usage）绿

### Defer（不挡首发）

- 完整 AI Agent 多阶段报告流水线（现有 chat 可只读辅助；Stage1 zip 能力推后）  
- 小程序  
- 付费墙 / 兑换码 / 微信 OAuth（旧仓有，新栈未作为 SoT）  
- 银行多源牌价刮取（旧 `bank_rate`）；先单一可靠 provider  
- 完美 i18n 全量、PDF 精美报告、复杂更正全部边角  
- Guest 免登录全链路（旧 PRD V6 能力）  
- 修改计划日期等「待确认」项（阶段 5 已建议移出 MVP）

### 当前最大风险（基于证据）

- README/对外仍像「骨架」，但业务已重——**文档与真实完成度不同步**，排期易误判（已用过时审查报告为例）。  
- REBUILD **缺本地 `.env.local` 实文件**（NEW 有）→ 新人/agent 无法一键起服。  
- 双 remote（`jiangxiaoyu66` vs `NOmoreJoke`）易推错仓。  
- 旧栈「已上线」叙事与新栈「要上线」并存 → 域名/服务器（`fxplanner.zyaoai.com` 出现在 compose 注释）需确认是否切流到新镜像。

---

## 8. 建议下一步 3–5 个工程 ticket（给工程 bot）

> 不启动 Cloud Agent、不 push、不部署，除非你再次明确授权。

1. **T1 · 本地可运行性**  
   - 从 `FXPlanner-new` 安全迁移 `.env.local` 三件套到 REBUILD（或按 example 重建）。  
   - `bun install` → `prisma migrate deploy` → `bun run dev` → 健康检查与登录冒烟。  
   - 产出：一页 `docs/LOCAL_BOOTSTRAP.md`（端口 3001/4001、DB 名）。

2. **T2 · MVP 完成度真相表（刷新 09-17 审查）**  
   - 对照 `docs/…/13_MVP功能清单.md` 与现 `src`/`e2e`，输出「✅/🟡/❌」新表到 `changes/mvp-completion/审查报告-20261103.md`。  
   - 标出上线前必须修的 🟡/❌（尤其前端 usage 入口是否藏在 plan 详情而非独立路由）。

3. **T3 · 上线闭环补洞（仅 must-have）**  
   - 按 T2 结果实现/修通：使用记录 UI 入口、计划完成确认、提醒中心最小集、报告只读摘要。  
   - 补 E2E：`11-plan-usage` 等在 CI/本地稳定绿。

4. **T4 · 部署预检（只读 + 清单，默认不执行 deploy）**  
   - 核对 `infra/compose/compose.prod.yaml`、`deploy.sh`、GHCR 镜像名与现服务器占用端口注释。  
   - 写出「首发 checklist」：环境变量、迁移、回滚、域名反代；**等你确认再动手部署**。

5. **T5 · 资料收口（可选并行）**  
   - 拷贝 Agent PRD/Stage1 zip、缺失 MVP 建模篇到 REBUILD `docs/`。  
   - 在 README 顶部加「SoT 声明」：本仓为唯一工程根；列出归档路径表（链到本简报）。

---

## 9. 给工程 bot 的硬约束（转述）

- 只在 `FXplannerREBUILD` 写代码与工程文档。  
- 禁止删除上述任何文件夹。  
- 禁止把旧 FastAPI/Vue 树 merge 进 monorepo。  
- 禁止未授权 push / 生产 deploy / 付费 Cloud Agent。  
- 密钥文件永不提交。

---

## 10. 附录：主要路径速查

```
SoT 工程:     /Users/kyle/Documents/工作/知爻/FXplannerREBUILD
旧 remote 镜: /Users/kyle/Documents/工作/知爻/FXPlanner-new
交接:         /Users/kyle/Documents/工作/知爻/交接/FXPlanner-new
产品资料:     /Users/kyle/Documents/工作/知爻/FXplanner
商业 BP:      /Users/kyle/Documents/凯衍磁缘/02_FXplanner
旧 Web:       /Users/kyle/Code/Project/FXplanner
旧 V1.2:      /Users/kyle/Code/Project/FXplanner-V1.2.0
小程序:       /Users/kyle/Code/Project/FXplanner小程序
```

---

## 设计/原型/约定（附录）

整合简报上文对 Pencil/PRD/术语包仅作高位索引，**不算设计层盘清**。

完整原型文件表、模块规格目录、命名/状态/金额/合规/Agent 约定锁点，以及「知爻完整包 vs REBUILD 缩水副本 vs 旧 Vue PRD」漂移说明，见：

→ [`NOMI-FX-DESIGN-INVENTORY-20261103.md`](./NOMI-FX-DESIGN-INVENTORY-20261103.md)

MVP 交互优先 **V2.5.pen**；产品规格优先 **知爻/FXplanner/MVP…/00–18**；工程金额与目录约定以 REBUILD `packages/money` + `AGENTS.md` 为准。

*本文件路径：`docs/NOMI-FX-CONSOLIDATION-20261103.md`*

---

## 11. 结构化导入落地（2026-11-03）

已按本简报 §5 / 设计盘点拷贝建议，将历史有用材料**复制**到：

→ [`imported-20261103/README.md`](./imported-20261103/README.md)

要点：产品规格进 `product-specs/`（不覆盖现有 `docs/MVP…` 缩水副本）；原型/Agent/BP/合规/learning-notes 已入树；真实 `.env.local` 仅在 `local-secrets/`（gitignore）；旧 Vue/FastAPI 源码与交接 bundle **未拷**（见同目录 `ARCHIVE-INDEX.md`）。
