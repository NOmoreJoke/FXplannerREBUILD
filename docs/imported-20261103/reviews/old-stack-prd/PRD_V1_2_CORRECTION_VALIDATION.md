# FXplanner V1.2.0 纠偏重构验收

日期：2026-07-30

源码基线：`c8cd8cdb4669e849fb3c35832dbbf27576abac6e`

隔离分支：`feature/prd-v1-2-correction`

## 1. 纠偏契约

| 项目 | 最终规则 |
|---|---|
| 运营市场 | `HK` 固定 |
| 用户资料地区 | `HK`、`CN`；只控制默认币种、语言、时区与适用规则 |
| 上线语言 | `zh-HK`、`zh-CN`、`en-HK` |
| Tier A | HKD、USD、GBP、AUD、CAD、CNY、JPY、EUR |
| Tier B | SGD、NZD、TWD、CHF、KRW；仅参考展示 |
| Tier C | 既有 ISO 4217 支持集合；仅记录 |
| 视觉 | Pencil emerald/cool-neutral；Light/Dark；Inter UI + IBM Plex Mono 数据 |
| 金额聚合 | 按成本币种分组；无换算依据时禁止跨币种裸求和 |

版本化 `contracts/product_catalog.v1.json` 为前后端统一能力目录；后端启动时 fail-fast 校验，前端直接消费同一 JSON。

## 2. 实际修改

- Identity Settings：地区、语言、基准币种均按 Catalog 校验；默认 HK/zh-HK/HKD/Asia-Hong_Kong。
- Onboarding：开放 HK/CN；完整 3 语言、8 个 Tier A、地区默认联动；保留登录页语言/主题；默认进入 `/app/home`。
- Shell/Login/Settings：完整三语选择；服务端偏好同步 Product UI；Light/Dark 状态一致；可见文案和 ARIA 同步本地化。
- Product：账户、目标、路径与设置币种全部由 Catalog 驱动；首页按成本币种分组汇总。
- Route Compare：所有 Tier A 货币对支持直连和确定性经 USD 路径；Tier B/C 拒绝执行型比较。
- 视觉：移除上一轮 orange/charcoal/Georgia 偏差，恢复 Pencil emerald/cool-neutral 令牌。
- 部署构建：Backend 镜像包含 `contracts/`，避免运行时缺少能力目录。

## 3. 外部审计

ChatGPT Pro 对话：<https://chatgpt.com/c/6a6ab456-f884-83ea-be93-b005351d9ac7>

外部高级工程师完成静态审计，确认根因是缺失统一 Capability Catalog。其结论未直接采信；本地基于 PRD、源码、数据库、浏览器和自动门禁独立复核。外部报告：

`/Users/kyle/Documents/Codex/2026-07-30/fxplanner-refactor-correction/CHATGPT_PRO_REVIEW.md`

## 4. 源码包

| 包 | 大小 | SHA-256 |
|---|---:|---|
| 完整基线包 `FXplanner-source-c8cd8cd.zip` | 37,817,124 bytes | `861978c103f9c35b84b5642984558a93e95ab701a364867cfc65c89922c781ea` |
| 优化代码包 `FXplanner-source-c8cd8cd-code.zip` | 991,838 bytes | `a7b20d05644e377036afbe27776155934ccc71a767ee1baa1e862a70413bf375` |

上传包为优化代码包；ChatGPT Pro 报告中的完整包哈希比较不适用于上传附件，已在本地报告中纠正。扫描工具 gitleaks/trufflehog/detect-secrets 不可用；上传前正则扫描只发现测试假 `sk-*`，真实凭据命中 0。

## 5. 自动验收

| 门禁 | 结果 |
|---|---|
| Backend strict | 653 passed；10 个 PostgreSQL 条件测试跳过 |
| PostgreSQL 条件测试 | 10 passed |
| Alembic 新库 | 001→019；`019_atomic_ledger_imports (head)` |
| Ruff | PASS |
| Mypy | 332 files；0 issues |
| Frontend unit | 15 files；60 passed |
| Type/build | vue-tsc + production build PASS；148 modules |
| Compliance | 0 违规 |
| Browser mock | Chromium 19 passed |
| Browser real local | FastAPI + PostgreSQL + Redis + WebSocket + Chromium；1 passed |
| npm audit | 0 vulnerabilities |
| pip-audit | 0 known vulnerabilities |
| Bandit | medium/high 0 findings |
| Diff hygiene | `git diff --check` PASS |

真实本地 E2E 覆盖 auth、onboarding、settings、fake payment webhook、account、canonical input、CSV 原子导入、goal、plan、route、simulation、report、credits、WebSocket。Fake PaymentAdapter 仅代表本地链路，不代表真实商户或生产验证。

## 6. 浏览器人工验收

- 登录页选择 `zh-CN + dark` 后，Onboarding 保持 `lang=zh-CN`、`html.dark`、`#101713 / #42c996`。
- 已完成用户把本地缓存改为 zh-HK/light 后重新登录：服务端 zh-CN/dark 恢复为 `lang=zh-CN`、`html.dark`、`#101713 / #42c996`。
- Shell 切换为 en-HK/light 后刷新仍保持 en-HK/light；随后恢复 zh-CN/dark 并持久化成功。
- 地区切换 CN 后自动联动 CNY、Asia/Shanghai、zh-CN。
- Onboarding 提交进入 `/app/home`，不再落入旧 `/dashboard`。
- Settings 显示 3 个上线语言与 8 个 Tier A 基准币种。
- Route Compare 实际执行 EUR→JPY，返回 EUR→JPY 和 EUR→USD→JPY 两条路径。

本地用户验证：

- Frontend：`http://127.0.0.1:5174`
- Backend：`http://127.0.0.1:8001`
- 隔离开发验证码：`123456`

## 7. 已处理的验证环境问题

| 现象 | 结论/处理 |
|---|---|
| 复用 PostgreSQL 容器密码不匹配 | 非产品失败；新建 tmpfs PostgreSQL 16，迁移与条件测试通过 |
| Bandit 首次把 `.venv` 纳入扫描 | 修正 exclude；仓库 Backend medium/high 0 |
| Playwright localhost 健康探针被系统代理返回 502 | 两套配置固化 `NO_PROXY=127.0.0.1,localhost`；默认命令恢复自动启停服务 |
| Real E2E 默认端口探针受同一代理影响 | 修复配置后以隔离端口 8013/4175 验证，1/1 通过 |

## 8. 未验证与边界

- 未部署；未迁移生产数据库；未修改线上配置或真实用户数据。
- 未验证真实支付商户、退款/争议、生产 webhook、真实邮件送达、微信 OAuth、Web Push、语音/OCR、对象存储和生产汇率 SLA。
- `.pen` 原型文件未修改：Pencil MCP 将目标 FXplanner 文件错误路由到另一活动画布；为避免损坏原型，本轮仅依据已读取的 FXplanner 原型令牌修复代码，并以浏览器复核。不得把代码视觉复核声称为原型文件交付。

## 9. 独立交付质量审计

最终独立 Agent 首轮结论：P0=0、P1=2、P2=3、P3=1，未直接放行。全部证据已处理：

| 审计发现 | 修正与回归 |
|---|---|
| 服务端语言/主题未同步 Product Shell | `syncFromSettings`；App 启动、登录完成均同步；单测与真实浏览器缓存冲突场景通过 |
| Login 仍混用旧 navy/teal | Login 与闲置弹窗统一 `--fxp-*`；E2E 校验 Dark `#101713/#42c996` 与实际按钮背景 |
| 公共 Store 导出跨币种裸总和 | 删除 `totalBalance`；改为 `balancesByCurrency`；USD/CAD 分组单测 |
| Route 非法 Decimal 可 500 | Pydantic 拒绝 NaN/Infinity/非数字/非正数；全部返回 422 |
| Login 可见文案/ARIA 未完整本地化 | 语言 ARIA、移动副标题、本机测试入口完成三语；真实 E2E 改用稳定 test id |
| 前端 Catalog fail-fast 过弱 | 补重复项、Tier mode/codes、能力键和值、地区默认值和 Tier C policy 校验 |
| Shell 切换只写本地、刷新被覆盖 | Product/Context Shell 双向写入 Settings；失败回滚；单测与真实浏览器刷新通过 |
| 闲置提示仍有旧色与固定简体文案 | Login/Modal 使用 `--fxp-warning`；弹窗完整 zh-HK/zh-CN/en-HK；主题按钮补三语 ARIA |
| 连续偏好写入存在响应乱序竞态 | Settings 全局串行更新队列；延迟 Promise 回归确认旧响应不能覆盖新值；过期失败不回滚新 UI |
| 前景白色与遮罩未令牌化 | 增加 Light/Dark `--fxp-on-accent` 与 `--fxp-overlay`，覆盖 Login、Modal、Onboarding 与 Shell 交互元素 |

新增后端回归遍历 8 个 Tier A 的 56 个有向异币种组合，并验证全部直连、适用时经 USD；非执行币种继续拒绝。

第 5 轮最终只读复验：`P0=0 / P1=0 / P2=0`。专项 Shell/Settings 2 tests、完整 Frontend 60 tests、production build 148 modules、受影响 Backend 42 tests、`git diff --check` 均通过。重点确认 A→B→C 两次快速写入均失败时，第二次从服务器已确认值回滚，不回落到未持久化 B。
