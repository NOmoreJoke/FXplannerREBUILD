# FXplannerREBUILD 迭代现状与工程 Backlog（2026-11-03）

> 回答：当前是否有结构化迭代计划？需要额外开发支持的任务有哪些？  
> 依据：`docs/开发计划/MVP开发计划.md`（2026-11-03 审计）、`changes/mvp-completion/*`、`docs/NOMI-FX-CONSOLIDATION-20261103.md`、`docs/NOMI-FX-DESIGN-INVENTORY-20261103.md`、代码树 / E2E / GitHub issues 交叉核验。  
> 范围：只排 **FXplannerREBUILD**（`NOmoreJoke/FXplannerREBUILD`，本地 `dev@1d0ace2`）。不启动 Cloud Agent、不 push、不部署，除非 Kaiming 再次明确授权。

---

---

## 0. 方法论增量（Poteto / pstack · 2026-11-05）

跨项目真源：`/Users/kyle/Documents/工作/知爻/NOMI-ACTIVE-PROJECTS-20261105.md` §0。  
对本仓含义：PR#1 收尾与 Iteration A 验收以**真实行为证明**为准；重复捷径优先落类型/lint/E2E，不堆 AGENTS；不开放 agent 自合并。视频：https://www.youtube.com/watch?v=MN9dGgmLyso


## 1. 现状结论（有没有结构化迭代计划）

| 判断 | 说明 |
| --- | --- |
| **有，但分散且部分过时** | 不是「没有计划」，而是 **历史波次计划已完成、阶段计划已部分过期、最新审计清单未改写成「面向上线的 2–3 个 iteration」**。 |
| 当前最可信的进度 SoT | `docs/开发计划/MVP开发计划.md`（**2026-11-03 审计勾选**）+ README「产品能力」叙述 + 现有 `services/chat/src` / `e2e/modules` |
| GitHub Issues | `NOmoreJoke/FXplannerREBUILD` **开放 issue = 0**（无看板票据） |
| Linear / Notion 工程板 | Notion 仅有日记/域名碎片，**无活跃 sprint backlog**；仓库内无 Linear 引用 |
| 工程变更文档 | `changes/<feature>/` 有大量技术方案与验收；**多数功能已交付**；未闭环的是 `mvp-completion` 收尾项 |

### 1.1 现有计划清单（路径 · 日期 · 是否仍有效）

| 文档 | 日期/语境 | 状态 | 建议处置 |
| --- | --- | --- | --- |
| `docs/开发计划/MVP开发计划.md` | **2026-11-03 审计更新**；内含历史 W0–W7 worktree 波次 | **进度勾选有效**；W0–W7 表标注「历史规划存档，执行已完毕」 | **保留为模块完成度 SoT**；上线排期改以本文 Iteration A/B/C 为准 |
| `changes/mvp-completion/审查报告与开发计划.md` | **2026-09-17** | **主干结论过时**（写「M7–M11 未开工」；现已有 usage/correction/reminder/report/data-request + 对应 E2E） | **整体 superseded**；仅可作历史缺口叙事。阶段 5 收尾意图仍有效，细节以「阶段5方案 + 2026-11-03 审计」为准 |
| `changes/mvp-completion/阶段5-收尾项方案.md` | 随审查报告产出（方案级，约 Sep 窗口） | **方案仍有效且未实施**：§1 首页「新建计划」、§2 账户分配视图、§3 列表进度条、§5 `07-plan-lifecycle`；§6 改日期移出 MVP 仍成立；§4/§5 之 usage E2E 已有 `11-plan-usage.spec.ts`（文件已存在） | **技术设计 SoT（收尾）**；实施排进 Iteration A |
| `docs/NOMI-FX-CONSOLIDATION-20261103.md` §7–§8 | 2026-11-03 | **快速上线 must-have / Defer / T1–T5 ticket 有效** | 与本文合并；T1 本地 env 已基本落地（根/web/chat `.env.local` 已存在），其余仍开 |
| 各 `changes/<模块>/技术方案.md` | Oct 22 树内 | 多数 **已交付归档** | 不作为新迭代主计划；改代码时按需查阅 |
| 旧仓 `知爻/FXplanner` / `Code/Project/FXplanner` 的 sprint 叙事 | 2026-06~09 | **栈不兼容 / 不参与上线排期** | 忽略为工程节奏；产品规格继续用资料库 |

### 1.2 一句话

> **结构化迭代计划：有模块级完成度表 + 过时的 09-17 五阶段计划 + 未执行的阶段 5 收尾方案；缺的是「面向快速上线」的现行 sprint 节奏与可派发任务单。**  
> 本文即补这一层；之后工程派活以 **本文 P0/P1/P2** 为准，09-17 审查报告不再当进度真相。

---

## 2. 对照「快速上线 Must-have」（Consolidation §7）

| # | Must-have | 代码/证据现状（2026-11-03） | 上线前动作 |
| --- | --- | --- | --- |
| 1 | 注册/登录 + 条款/年龄 | ✅ auth + OTP + TermsConsent；E2E `01/05` | 冒烟确认即可 |
| 2 | Onboarding 建账 | ✅；草稿 30 天 ❌（审计已记） | 决策降级或补做（产品） |
| 3 | 汇率可用 + 过期行为 | ✅ + cron/图表超计划 | 冒烟 |
| 4 | 账户 / 买入（手续费三态） | ✅ | 冒烟；分配明细视图仍缺（见 P0） |
| 5 | 计划 + 分配 + 分批 | ✅ | 补列表进度条 / 生命周期 E2E（P0） |
| 6 | 资金使用闭环 | ✅ 后端+前端+`11-plan-usage` | 走查入口是否好找；稳定绿 |
| 7 | 首页建计划/录买入/看进度 | 🟡 仅「录入买入」；**无正常态「新建计划」**；空态有入口 | **P0 必补** |
| 8 | 生产 compose + 密钥 + health | ✅ `infra/compose` + CI；需服务器 env/切流确认 | **部署预检清单（P0 只读）** |
| 9 | 最小合规文案 | 🟡 空态有免责注释区；需核对落地页/报告是否处处可见 | **P0 文案走查 + 固化** |
| 10 | typecheck + 关键 E2E 绿 | 有脚本；需本地/CI 再跑一轮 | **Iteration A 验收硬门槛** |

**Defer（明确不挡首发）**：深度 AI Stage1、小程序、付费/OAuth、多银行牌价、完美 i18n、PDF 精美报告、改计划日期、Guest 全链路。

---

## 3. 建议的迭代节奏（2–3 个 Iteration，面向快速上线）

原则：主链已齐 → **不再开大模块**；只打「演示不断、合规不踩雷、能部署」的洞；每 iteration ≤ 数天级，验收可演示。

### Iteration A — 「可演示闭环 UI + 回归网」（目标：本地演示零死胡同）

**目标**：正常态首页能直达建计划；账户能看见钱分给了谁；计划列表能扫进度；M5 生命周期有 E2E；合规短句就位；关键套件绿。

**退出标准**

1. 已建账用户首页顶栏可见「新建计划」→ `/plans/new`  
2. `GET /api/accounts/:currencyCode/allocations` + 账户页只读表  
3. 计划列表卡有准备进度条（口径对齐阶段5 §3 / plan-calculator `gap`）  
4. `e2e/modules/07-plan-lifecycle.spec.ts` 本地 0 failed  
5. 落地页/首页/报告可见最小免责声明  
6. `bun run` typecheck + auth/plan/transaction/usage 相关 API 或 E2E 子集绿  

**对应任务**：下文 **P0-1 ~ P0-6**

### Iteration B — 「上线就绪（配置 · 文档 · 完成度真相）」

**目标**：任何人（含工程 bot）能一键起服；完成度表刷新到「与代码一致」；生产 checklist 写好但 **默认不执行 deploy**。

**退出标准**

1. `docs/LOCAL_BOOTSTRAP.md`（端口 3001/4001、DB、三份 env）  
2. `changes/mvp-completion/审查报告-20261103.md` 新 ✅/🟡/❌ 表  
3. `docs/LAUNCH-CHECKLIST.md`（env、迁移、回滚、nginx、域名切流问题清单）  
4. README 顶部 SoT 声明链到 consolidation / 本文  

**对应任务**：下文 **P0-7 ~ P0-9、P1-1**

### Iteration C — 「首发后增强（可并行、可砍）」

**目标**：不挡上线的体验与能力债；额度/人力够再开。

**候选**：i18n；单计划 PDF；收益比较数值（待 doc 12 定稿）；onboarding 草稿或正式降级记录；全链路单条 E2E；Agent Stage1 对齐。

**对应任务**：下文 **P1-2 ~ P1-5、P2-***

```
Iteration A (UI收尾+E2E+合规) ──► Iteration B (起服文档+真相表+部署清单)
                                      │
                                      └─(可选)► Iteration C (i18n/PDF/草稿/全链路)
```

---

## 4. 需要额外开发支持的任务清单（可派「工程」bot）

> 工具约定：**默认本地 Codex / 本机 Cursor 工程会话**；**勿 Cloud Agent**，除非 Kaiming 再确认。  
> 只写 `FXplannerREBUILD`；禁止 merge 旧 Vue/FastAPI；密钥不进 git；不擅自 push/deploy。

### 4.1 P0（Iteration A / B，上线前）

#### P0-1 · 首页正常态「新建计划」入口

| 项 | 内容 |
| --- | --- |
| **目标** | 已建账首页顶栏与「录入买入」并排增加 outline「新建计划」→ `/plans/new` |
| **验收** | 正常态可见；空态不重复；E2E 或导航断言覆盖；对照 `阶段5-收尾项方案.md` §1 |
| **依赖** | 无 |
| **归属** | 纯工程（方案已定） |
| **工具** | 本地 Codex；文件：`clients/chat-web/components/business/home/home-dashboard.tsx` |

#### P0-2 · 账户页按计划分配只读视图

| 项 | 内容 |
| --- | --- |
| **目标** | `GET /api/accounts/:currencyCode/allocations` + 前端只读表 + `generate:api` |
| **验收** | 多计划金额/剩余正确；CANCELLED 剩余 0 仍列出；API 测试进 `account.spec.ts`；对照阶段5 §2 |
| **依赖** | 无（可与 P0-1 并行） |
| **归属** | 纯工程 |
| **工具** | 本地 Codex；`services/chat/src/account/*` + `plan-allocation-table.tsx` |

#### P0-3 · 计划列表准备进度条

| 项 | 内容 |
| --- | --- |
| **目标** | `plan-list.tsx` PlanCard 展示准备进度（用服务端 `gap`，禁止裸 parseFloat 算钱） |
| **验收** | 0/50/100% 档合理；`03-plan` 可扩断言；对照阶段5 §3 |
| **依赖** | 无 |
| **归属** | 纯工程 |
| **工具** | 本地 Codex |

#### P0-4 · E2E `07-plan-lifecycle.spec.ts`

| 项 | 内容 |
| --- | --- |
| **目标** | 补齐 M5：新建→调目标→调分配→取消→重开（阶段5 §5 五条） |
| **验收** | `./e2e/scripts/run-e2e-tests.sh` 含本文件 0 failed；产物只进 `e2e/test-results/` |
| **依赖** | P0-1（入口断言）；建议 P0-2/P0-3 后写，便于串断言 |
| **归属** | 纯工程 |
| **工具** | 本地 Codex + Playwright |

#### P0-5 · 最小合规文案固化

| 项 | 内容 |
| --- | --- |
| **目标** | 落地页 / 首页 / 报告页可见「非投资建议、不预测涨跌、不经手资金」类短句；可先手工常量 |
| **验收** | 关键路由肉眼可见；对照 `docs/imported-20261103/compliance/` 与旧仓封杀词精神（**移植规则不移植旧代码**） |
| **依赖** | **产品确认最终措辞**（Kaiming）→ 工程落位 |
| **归属** | 产品定稿 + 工程实施 |
| **工具** | 本地 Codex（文案由人批） |

#### P0-6 · 关键冒烟绿灯

| 项 | 内容 |
| --- | --- |
| **目标** | typecheck + auth/plan/transaction/usage（及 A 中新改动相关）测试绿 |
| **验收** | 日志可贴进验收；失败修到 0 failed |
| **依赖** | P0-1~4 合入后跑 |
| **归属** | 纯工程 |
| **工具** | 本地 |

#### P0-7 · 本地可运行性文档（T1 收口）

| 项 | 内容 |
| --- | --- |
| **目标** | 写出 `docs/LOCAL_BOOTSTRAP.md`；核对三份 `.env.local`（**已存在则勿覆盖密钥，只文档化**） |
| **验收** | 按文档可从干净状态起服到登录；端口/DB 写死 |
| **依赖** | 无 |
| **归属** | 纯工程 |
| **工具** | 本地；**不提交真实密钥** |

#### P0-8 · MVP 完成度真相表刷新（T2）

| 项 | 内容 |
| --- | --- |
| **目标** | 对照 `13_MVP功能清单.md` + 现 src/e2e，输出 `changes/mvp-completion/审查报告-20261103.md` |
| **验收** | 明确标注 09-17 报告过时；标出仍 🟡/❌ 且是否挡上线；usage 入口路径写清 |
| **依赖** | 建议 Iteration A 代码洞补完后写，避免再过时 |
| **归属** | 工程（可含产品一眼确认） |
| **工具** | 本地；只读代码 + 写 md |

#### P0-9 · 部署预检清单（T4，默认不部署）

| 项 | 内容 |
| --- | --- |
| **目标** | `docs/LAUNCH-CHECKLIST.md`：compose.prod、deploy.sh、GHCR、nginx、健康检查、回滚、**域名是否从旧栈切到新镜像**（`fxplanner.zyaoai.com` 等）待确认项 |
| **验收** | 清单可勾选；**不执行生产 deploy** |
| **依赖** | **切流/域名决策 = Kaiming** |
| **归属** | 工程列清单 + 产品拍板切流 |
| **工具** | 本地只读；勿 Cloud Agent |

### 4.2 P1（Iteration B 尾巴 / C）

| ID | 目标 | 验收 | 依赖 | 归属 | 工具 |
| --- | --- | --- | --- | --- | --- |
| **P1-1** | README SoT 声明 + 链到 consolidation / 设计盘点 / 本文 | README 顶部 10 行内说清「唯一工程根」 | 无 | 工程 | 本地 |
| **P1-2** | i18n（next-intl 或等价）：默认 zh-CN，抽已有页词条 | 可切换 en；不挡首发可砍到 C | 页面定型（A 后） | 工程；文案审 = 产品 | 本地 |
| **P1-3** | 单计划 PDF 下载 | 有有效使用才生成；进行中/完成/取消可下；已下 PDF 不随后续更正变 | M10 摘要已有；PDF 引擎选型需工程估时 | 工程；范围确认 = 产品 | 本地 |
| **P1-4** | 「多换目标币」简单比较数值 | 占位枚举填实数 | **doc 12 算法定稿（产品）** | 产品先 → 工程 | 本地 |
| **P1-5** | Onboarding 草稿 30 天：**实施或书面降级** | ~~审计项关闭~~ **已关闭（2026-11-05 书面降级）** | ~~产品二选一~~ 已决策 | 产品决策 + 工程 | 本地 |
| **P1-6** | 全链路单条 E2E（登录→建账→买入→计划→分批→使用→完成→报告） | 1 条长用例稳定 | A 的 07 + 现有 11-* | 工程 | 本地 |

### 4.3 P2（明确后置）

| ID | 目标 | 备注 |
| --- | --- | --- |
| **P2-1** | Agent Stage1 zip / PRD 与现 `services/chat/src/ai` 差距对齐 | 见 `docs/imported-20261103/agent/`；不挡首发 |
| **P2-2** | 小程序对接 REBUILD API | `FXplannerMiniProgram` 仅骨架 |
| **P2-3** | 付费墙 / 兑换码 / 微信 OAuth | 旧栈有，新栈非 SoT |
| **P2-4** | 多银行牌价刮取 | 先单一 provider |
| **P2-5** | 功能 29 修改计划日期 | 阶段5 §6 已建议移出 MVP；规格未收敛前禁止实现 |
| **P2-6** | 合规 lint 自动化（旧仓规则移植） | 首发手工文案即可 |

---

## 5. 产品/设计决策（Kaiming）vs 纯工程

### 必须 Kaiming 拍板

1. **上线范围冻结**：是否接受 Consolidation Must-have + 本文 Iteration A/B，其余进 C/Defer  
2. **Onboarding 草稿**：~~做 30 天保留，还是文档降级「向导一次性提交、无草稿」~~ **已决策（2026-11-05）：书面降级**——向导一次性提交、无草稿（代码现状即此形态，`onboarding/page.tsx` 注释「状态全部在内存，中断即丢弃」）；理由：MVP 范围外 + 优先稳定 PR #1。30 天草稿若未来重启，按阶段5 §6 同款「纯增量」评估。
3. **合规最终措辞**与展示面（仅空态 vs 全局 footer）  
4. **域名/服务器切流**：旧栈叙事 vs REBUILD 新镜像谁接 `fxplanner.*`  
5. **doc 12 收益比较算法**是否首发需要（建议否）  
6. **i18n / PDF** 是否进首发（建议否）  
7. **是否授权** push、生产 deploy、或 Cloud Agent（默认否）

### 纯工程（方案已够细，可直接派）

- P0-1、P0-2、P0-3、P0-4、P0-6、P0-7、P0-8、P1-1  
- P0-9 清单起草（切流项留空给产品）  
- P0-5 在措辞确认后的落位  

### 设计侧（非本迭代阻塞）

- V2.5.pen 与现 UI **逐像素对照**未做（见设计盘点）；上线不以像素对齐为门槛  
- 术语表/状态机注释（如 `STOPPED`）漂移：可另开文档债，不挡 A  

---

## 6. 应视为已被 supersede 的计划

| 被替代文档 | 被谁替代 | 注意 |
| --- | --- | --- |
| `changes/mvp-completion/审查报告与开发计划.md`（2026-09-17）中「M7–M11 未开工」及阶段 1–4 排期 | 2026-11-03 `MVP开发计划.md` 审计 + 本文 Iteration A/B/C | **勿再按「先做 M7」派活**——M7–M11 代码与 E2E 已在 |
| 同文件阶段 5「依赖 M7 才写 usage E2E」 | 已有 `e2e/modules/11-plan-usage.spec.ts` | 阶段5方案里 §5 的 usage 文件规划 **部分过时**；仍缺的是 **`07-plan-lifecycle`** |
| `MVP开发计划.md` 内 W0–W7 并行波次表 | 标注存档；节奏改本文 | 纪律条款（schema 冻结等）仍可参考，但不再开 worktree 大战 |
| 旧 Vue/FastAPI sprint「已上线」叙事 | Consolidation：新栈单独上线路径 | 禁止把旧仓进度算进 REBUILD 完成度 |
| Consolidation T1「从 NEW 迁 env」 | 本地三份 `.env.local` 已存在（2026-11-03） | 改为「文档化 + 勿覆盖」；若密钥无效再重建 |

**仍有效、勿 supersede**

- `阶段5-收尾项方案.md` §1–§3、§5（07-lifecycle）、§6（改日期移出）  
- `docs/开发计划/MVP开发计划.md` 2026-11-03 勾选与遗留五条  
- Consolidation §7 Must-have / Defer 与工程硬约束  

---

## 7. 建议派发顺序（给工程 bot 的抄送块）

```
【FXplanner 工程派发 · Iteration A】
仓库：/Users/kyle/Documents/工作/知爻/FXplannerREBUILD （仅此仓）
分支：dev
禁止：Cloud Agent / push / 生产 deploy / 提交 .env.local
阅读：docs/NOMI-FX-ITERATION-AND-BACKLOG-20261103.md
      changes/mvp-completion/阶段5-收尾项方案.md
立刻做：P0-1 → P0-3 → P0-2（可并行）→ P0-4 → P0-6
并行等产品：P0-5 措辞
质量红线：AGENTS.md；方案含测；0 failed；E2E 产物只进 e2e/test-results/
```

Iteration B：P0-7、P0-8、P0-9、P1-1（A 验收通过后）。

---

## 8. 相关路径速查

| 用途 | 路径 |
| --- | --- |
| 本 backlog | `docs/NOMI-FX-ITERATION-AND-BACKLOG-20261103.md` |
| 模块完成度 | `docs/开发计划/MVP开发计划.md` |
| 收尾技术方案 | `changes/mvp-completion/阶段5-收尾项方案.md` |
| 过时审查（历史） | `changes/mvp-completion/审查报告与开发计划.md` |
| 整合 / must-have | `docs/NOMI-FX-CONSOLIDATION-20261103.md` |
| 设计盘点 | `docs/NOMI-FX-DESIGN-INVENTORY-20261103.md` |
| 导入资料 | `docs/imported-20261103/` |
| 部署 | `infra/compose/` |
| E2E | `e2e/modules/`（缺 `07-plan-lifecycle.spec.ts`） |

---

*生成：2026-11-03（Asia/Shanghai）。证据以当时本地 `dev` 树为准；合入后请用 P0-8 真相表再刷一版勾选。*
