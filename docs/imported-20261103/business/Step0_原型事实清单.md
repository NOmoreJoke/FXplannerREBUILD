# Step 0 — FXplanner 原型事实清单

**采集日期**：2026-05-05
**采集范围**：`/Users/kyle/Code/Project/FXplanner` 仓库
**唯一来源**：`README.md`（v3.51, 2026-04-15）+ `SPEC.md`（v1.2, 2026-03-24）+ `CHANGELOG.md`
**源内冲突处理规则**：以 `README.md`（2026-04-15 v3.51）状态为准。`docs/TODO.md`、`docs/ITERATION_PLAN.md` 为过程视图（包含未勾选完成的旧条目，例如"v3.51 上线阻塞 K780 配置 / DNS A 记录 / SSL 证书获取 / 微信回调域名"），与 README 的当前状态冲突时**一律以 README 为准**——README 已确认 ICP 备案（2026-04-09）、HTTPS+HSTS、SSL 证书（至 2026-07-08）、银行牌价性能修复（首次 ~1.7s / 二次 0ms）均已上线运行。
**用途**：Step 1（技术可行性）与 Step 2（实施方案）章节的唯一事实来源；任何与"已上线/已实现/已测试"相关的描述必须回查本清单。

---

## 1. 项目身份

| 字段 | 值 |
|---|---|
| 项目标准中文名 | FXplanner 跨币种现金流规划与外汇成本优化工具 |
| 英文名 | FX Planner / FX Sub Saver |
| 一句话定义 | 面向中国大陆用户的外币支出管理工具：记账 + 汇率信息助手，不触碰支付与投资建议 |
| 公网访问域名 | `https://app.fxplanner.cn` ✅ HTTPS+HSTS 已启用 |
| API 域名 | `https://api.fxplanner.cn` |
| 注册主域 | `fxplanner.cn` |
| ICP 备案 | ✅ 2026-04-09 通过（备案号占位 `[ICP-PLACEHOLDER]`，定稿前替换）|
| SSL 证书 | Let's Encrypt（DNS 验证），有效期至 2026-07-08 |
| 服务器 | 阿里云 ECS `fxplanner-prod`（华东 1 杭州）|
| 部署模式 | Docker Compose 5 容器编排 + 1Panel OpenResty 反代 |
| 当前版本 | v3.51（2026-04-15）|

## 2. 技术栈（写入"一、技术内容"与"三、线上服务架构"）

| 层 | 选型 |
|---|---|
| 前端框架 | Vue 3 + Composition API + TypeScript |
| 构建 | Vite |
| 样式 | TailwindCSS（CSS 设计 Token，支持深色/浅色模式）|
| 状态管理 | Pinia |
| 路由 | Vue Router |
| HTTP | Axios |
| 图表 | ECharts（汇率趋势图）|
| 国际化 | vue-i18n（中/英/日 三语）|
| 后端框架 | FastAPI ≥ 0.116.0（Python 3.11）|
| ORM/迁移 | SQLAlchemy + Alembic（001→005 已执行）|
| 主数据库 | PostgreSQL 16（开发可用 SQLite）|
| 缓存 | Redis 7（连接超时配置 `socket_connect_timeout=1.0s` / `socket_timeout=2.0s`，源：`backend/core/redis_config.py`）|
| 认证 | JWT + 邮箱 OTP（生产已用）；微信 OAuth 代码链路已实现（Mock/Sandbox 已可用，**生产待企业资质 + 微信回调域配置**） |
| LLM Provider | GLM（智谱 AI，OpenAI 兼容协议）glm-5-turbo |
| 反向代理 | 1Panel OpenResty（替代 Docker Nginx 容器）|
| CI/CD | GitHub Actions（pytest + vite build 双门禁 → SSH 部署 → Alembic 迁移 → 健康检查）|

### 语音与端侧技术路线（含已用与规划）

| 选型 | 阶段 | 说明 |
|---|---|---|
| 浏览器原生 Web Speech API | ✅ 已用（Web 端线上原型）| Web 端语音录入入口；STT 失败时退回打字 |
| Tauri 2.0 | ⏳ P0/P1 规划（尚未部署）| 桌面端（Windows/macOS）+ 移动端（iOS/Android）封装 |
| 本地 Whisper | ⏳ 规划（伴随 Tauri 桌面端）| 离线 STT 路径，替代浏览器 STT |
| MCP Server | ⏳ Sprint H3 规划（2026 Q4）| 开放给第三方智能体调用 |

## 3. 后端 DDD 六大上下文（写入"一、技术原理"）

```
backend/
├── shared/            共享内核（crypto、依赖注入）
├── identity/          认证与用户（JWT + 邮箱 OTP + 微信 OAuth）
├── subscription/      订阅域（CRUD、状态机、成本链路 A→B→C）
├── quota/             额度与预算（年度便利化 5 万美元 + 月度预算 + 三档阈值告警）
├── exchange_rate/     汇率域（多源聚合 + 银行牌价 + 信用卡费率）
├── ai_interaction/    AI 交互（LLM 解析 + 置信度标签 + 待确认流）
└── notification/      实时通知（WebSocket + 票据认证 + 5 类事件 + 指数退避重连）
```

## 4. 已实现的核心能力（"试运行已上线"事实集）

| 能力 | 实现细节 |
|---|---|
| 邮箱 OTP 登录 | 两步式（请求 OTP → 验证码登录）；DEBUG 模式下万能码 `123456` |
| 微信 OAuth | Mock/Sandbox 已实现；Prod 模式待企业资质 + 微信回调域配置 |
| AI 自然语言录入 | 文字/语音 → STT → LLM 解析 → 置信度标签 → 待确认流 → 用户确认入库 |
| 批量录入 | 一段话描述多个订阅，AI 同时解析 |
| 离线降级 | LLM 不可用时自动退回手动表单 |
| 年度购汇额度追踪 | 5 万美元法规额度 + 前瞻性预估（已用 / 含下笔 / 预估年底）|
| 月度预算 | 自然语言配置上限；三档阈值（80% 信息 / 90% 警告 / 100% 柜台办理告知）|
| 头像渐变环 | 双环（外环年度额度 + 内环月度预算），桌面 Popover / 移动 Bottom Sheet |
| WebSocket 实时通知 | 5 类事件 + 票据认证 + WS URL 自动推导 + 严格 fail-closed + 指数退避重连 |
| 闲置自动登出 | 30 分钟无操作自动退出，提前 2 分钟弹出倒计时警告 + "立即退出"次级按钮 |
| 银行牌价聚合 | 直连：农行（无认证）/ 工行（POST+Referer）/ 招行（Origin+Referer）；聚合降级（k780）：中行 / 建行 / 交行 |
| 银行牌价性能 | 首次 ~1.7s，二次访问 0ms（localStorage stale-while-revalidate 15min TTL + k780 并发化 + Redis 超时）|
| 信用卡外汇费率库 | 七行标准手续费 + 零费率代表卡 |
| Toast 通知系统 | 单例 + Portal 容器，success/error/info 三型 |
| 微交互 | Focus Ring / Hover Lift / Press Active / Value Flash / Header 滚动毛玻璃 |
| 国际化 | 中文 / English / 日本語 三语；登录后自动恢复语言；Settings 重置即时生效 |
| 主动提示卡片 | 距下笔扣款 ≤ 7 天且超阈值时弹出；按用户+按事件持久化 |
| 套利检测 | CNY → JPY → USD 路径；正负值附"节省/损耗 X.XX%"语义标签 |
| 成本链路 | A→B→C 最多 3 步货币转换 |
| 深色模式 | 全站 CSS 设计 Token；不使用纯黑（slate-900 系），警告横幅暗色半透明底 |

## 5. 测试与质量（写入"一、可靠性、安全性考核"）

| 项 | 值 |
|---|---|
| 当前测试基线 | **257 passed, 0 failed**（含单元 + 集成 + E2E）|
| E2E 框架 | Playwright（固定 `127.0.0.1:4173 strictPort`，避免端口占用）|
| 测试通过历史 | Sprint 7（223）→ Sprint 8B-1（227）→ Sprint 9A/9B（250）→ Sprint 9C（254）→ 当前（257）|
| 数据库迁移 | Alembic 001→005 全部生产执行完成 |
| CI/CD 门禁 | pytest + vite build 双门禁；SSH 部署；Alembic 迁移；健康检查 |
| 安全特性 | HTTPS + HSTS、JWT、邮箱 OTP、Refresh Token HttpOnly Cookie、生产 SECRET_KEY 校验、错误信息不外泄、N+1 防护、严格 fail-closed |
| 数据存储边界 | 不存银行卡号 / 身份证 / 真实交易流水 / 任何支付凭证 |

## 6. Sprint 进度（已完成 → 计划中）

### 已完成（截至 2026-04-15，v3.51）

| 编号 | 主题 |
|---|---|
| Sprint 0~3 | 项目初始化、设计令牌、Dashboard 重构、订阅管理 |
| Sprint 4 | DDD 后端重构、微信登录基础、自动化测试体系（149 passed）|
| Sprint 5 | AI 自然语言录入完整交付（163 passed）|
| Sprint 6 | 额度环 + 月度预算 + 阈值告警（192 passed）|
| Sprint 7 | WebSocket 实时通知 + 安全加固（217→223 passed）|
| Sprint 8A / 8A-2 | 闲置自动登出 + i18n 三语 + Settings 重构 |
| Sprint 8B | 生产部署：Docker / GitHub Actions / GLM / Alembic 005 / 1Panel OpenResty / SSL（上线 ✅）|
| Sprint 8C | Toast / Focus Ring / Value Flash / Header blur / 深色横幅修复（E2E 10 passed）|
| Sprint 9A/9B/9C | 六行银行牌价全栈（254 passed）|
| Sprint 10 | 邮箱 OTP 两步式登录 + 全量文档更新（257 passed）|
| Sprint 12A | UX 流程重塑（ConfigWizard 3 步向导 / AddSubscriptionModal 简化 / AiParseResultCard 分层）|
| Sprint 13A | 官网 Landing Page 暗色视觉（Stitch / Space Grotesk / 电路板纹理）|
| Sprint 13B | 汇率趋势图（ECharts）+ 全局品牌色蓝→Emerald |
| Sprint 13C | 全站深色模式修复（10 组件）+ SettingsView 重设计 + Settings API 路由修复 |
| Sprint 13D | 银行牌价性能修复（首次 ~1.7s / 二次 0ms）|

### 计划中（写入"三、产品开发计划"）

| 编号 | 主题 | 时间窗 |
|---|---|---|
| Sprint H1 | Harness AI 基础设施（统一 LLM 编排）| 2026 Q3 |
| Sprint H2 | 外部 Agent API（开放给第三方智能体调用）| 2026 Q3-Q4 |
| Sprint H3 | MCP Server（Model Context Protocol）| 2026 Q4 |
| 商业化 Sprint | 微信支付接入 + 付费墙 + 试用转付费 | 2027 Q1（依赖企业资质）|
| 运营后台 Sprint | 用户/订阅/汇率/通知后台管理 | 2027 Q1-Q2 |
| 移动端 Sprint | iOS/Android（Tauri 2.0 移动端）| 2027 Q2-Q3 |

## 7. 已对接的第三方 API / 数据源

| 类别 | 选型 |
|---|---|
| LLM | GLM（智谱 AI）glm-5-turbo |
| 汇率聚合（生产必配）| k780（双参数认证 appkey + sign，提供中行/建行/交行）|
| 汇率直连（无密钥）| ExchangeRate-API、Frankfurter ECB |
| 银行汇率直连 | 农行（无认证 JSON）、工行（POST+Referer）、招行（Origin+Referer）|
| 邮件 SMTP | 用于 OTP 发送 |
| 浏览器 STT | 浏览器原生 Web Speech API（Web 端）；本地 Whisper（Tauri 桌面端规划）|

## 8. 创新点（"一、技术创新"三类骨架）

| 类别 | 描述 |
|---|---|
| 应用创新 | 首个面向中国大陆外币支出场景的"规划层"工具——不参与支付与执行，专注于"在花钱之前帮用户做最优决策" |
| 技术创新 | LLM 解析 + 置信度待确认流 + 实时 WebSocket 通知三件套；银行直连 + k780 聚合双层降级架构 |
| 合规创新 | 零资金触达边界（不做支付/代付/账单关联/汇率预测/自动购汇/外汇额度规避建议），不依赖任何金融牌照即可服务跨境支出场景 |

## 9. 合规边界（写入"三、特殊行业许可证"节）

**当前 FXplanner 为"信息服务与规划工具"，不提供以下任何业务**：

- ❌ 外汇买卖 / 兑换执行
- ❌ 资金划转 / 支付清算
- ❌ 理财 / 投资建议（不含汇率预测语句）
- ❌ 资金托管
- ❌ 帮助用户规避外汇便利化额度

**已具备的资质**：

- ✅ ICP 备案 `[ICP-PLACEHOLDER]`（2026-04-09 通过）
- ✅ 阿里云华东节点（境内数据本地化）
- ✅ 数据存储边界遵循 PIPL（不存银行卡号/身份证/交易流水）

## 10. 知识产权状态（写入"一、知识产权权属与申报计划"）

| 类别 | 状态 | 计划 |
|---|---|---|
| 域名 `fxplanner.cn` | ✅ 已注册 | 多年续费 |
| ICP 备案 | ✅ 2026-04-09 通过 | 备案号待填 `[ICP-PLACEHOLDER]` |
| SSL 证书 | ✅ Let's Encrypt | 有效期至 2026-07-08，自动续期 |
| 计算机软件著作权 | ⏳ 未提交 | 计划 2026 H2 提交首批（FXplanner 主程序）|
| 商标 | ⏳ 未提交 | 计划 2026 H2 提交"FXplanner / 凯衍磁缘"|
| 核心规则库与提示词 | 🔒 商业秘密 | 权属归项目方，不公开 |
| 发明专利 | ⏳ 暂无计划 | 视后续算法独创性再评估 |

## 11. 文档资产清单

| 文档 | 路径 | 用途 |
|---|---|---|
| 产品规格 | `SPEC.md` | 单一真相来源，含产品定位、不做清单、合规边界 |
| 产品需求 | `docs/PRD.md` | 产品需求详述 |
| 技术架构 | `docs/TECH_ARCHITECTURE.md` | 含 Sprint H1/H2/H3 Harness 域设计 |
| 迭代计划 | `docs/ITERATION_PLAN.md`（v3.48）| Sprint 排期 |
| 部署指南 | `docs/DEPLOYMENT_GUIDE.md` | Sprint 8B 完整部署手册 |
| 测试报告 | `docs/TEST_REPORT.md` | 测试结果归档 |
| 测试指南 | `docs/TESTING_GUIDE.md` | 测试体系说明 |
| Landing Page 设计 | `docs/LANDING_PAGE_DESIGN.md` | Sprint 13A 设计稿 |
| 1Panel 迁移记录 | `1PANEL_MIGRATION.md` | 反向代理切换说明 |
| 更新日志 | `CHANGELOG.md` | 版本历史 |
| 原型设计 | `design/web-design.pen` | 唯一原型文件，36+ 画板 |

## 12. 占位符登记（定稿前替换）

| 占位符 | 含义 | 替换来源 |
|---|---|---|
| `[ICP-PLACEHOLDER]` | ICP 备案号实物字符串 | 项目方提供 |
| `[FOUNDER-CV-PLACEHOLDER]` | 创始人简历 | 项目方上传 PDF/DOCX |
| `[ALIYUN-BILL-PLACEHOLDER]` | 阿里云月均真实账单 | 项目方导出账单 |
| `[AI-TOOLS-BILL-PLACEHOLDER]` | AI 工具订阅 + LLM API 月均真实账单 | 项目方导出账单 |

---

**采集状态**：✅ 已锁定。后续 Step 1（技术章节）、Step 2（实施方案）、Step 3（投资估算 IP/合规部分）、Step 4（社会效益 IP 件数）、Step 6（跨章一致性）均以本表为唯一事实来源。
