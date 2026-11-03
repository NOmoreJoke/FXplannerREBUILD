# 上线预检清单（LAUNCH-CHECKLIST）

> **默认不执行任何部署**（backlog P0-9 约束：只写清单，deploy 授权与切流决策 = Kaiming）。
> 生成：2026-11-03（Iteration B）。配套：`docs/LOCAL_BOOTSTRAP.md`（本地）、`changes/mvp-completion/审查报告-20261103.md`（完成度真相）。

## 1. 镜像与 CI（自动侧，部署前核对）

- [ ] `docker-build.yml`：`feat/*|dev|main` push 触发 → `ghcr.io/jiangxiaoyu66/fxplanner-chat:latest` 与 `fxplanner-chat-web:latest` 构建成功
- [ ] `relay-images.yml`：postgres:16-alpine 中转镜像存在（服务器 docker.io 不可达的兜底）
- [ ] `ci.yml`：目标分支全绿（typecheck + 测试）

## 2. 服务器环境（`infra/compose/.env`，密钥不进 git）

- [ ] `DATABASE_URL`（强密码）、`JWT_SECRET`、`OTP_CODE_SECRET`（≥32 字节随机值）
- [ ] SMTP（阿里云 DirectMail）/ `ALIYUN_*` 短信键有效（若启用）
- [ ] `AI_PROVIDER_AIGYSD_*`（AI 助手启用时）、`CORS_ORIGIN=https://<生产域名>`
- [ ] 生产 `NODE_ENV=production`；`OTP_EMAIL_MOCK` **必须为 false**

## 3. 部署步骤（`infra/compose/deploy.sh`，需 Kaiming 授权后执行）

```bash
cd infra/compose
./deploy.sh deploy    # pull → postgres 等待 healthy → prisma migrate deploy → up -d
```

- [ ] 部署后健康检查：`GET /api/health` 200；前端落地页 200；注册→OTP→建账冒烟一条
- [ ] 数据库迁移为向前兼容（无 destructive 变更）；本次迭代无新迁移，`migrate deploy` 幂等

## 4. 回滚

- [ ] `./deploy.sh rollback`（脚本内置）回退上一镜像标签
- [ ] 数据库迁移回滚策略：生产仅跑 `migrate deploy`；若迁移需回退，先备份再人工处理（Prisma 无自动 down）
- [ ] 部署前 `pg_dump` 快照留存（服务器侧）

## 5. 网关 / 域名 / HTTPS（⏸ 待 Kaiming 拍板项）

- [ ] **域名切流决策**：`fxplanner.app` / `fxplanner.cn` / `fxplanner.zyaoai.com` 从旧栈（Vue/FastAPI）切到 REBUILD 新镜像？——旧栈叙事 vs 新栈直接接管，未定
- [ ] nginx/网关反代：`/api` → chat:4001（`/api` 前缀在应用内）、`/` → web:3001；WebSocket/SSE（AI 助手流式）透传配置
- [ ] HTTPS 证书（certbot/CDN）与 HSTS；ICP 备案信息挂 footer（`fxplanner.cn` 必须）
- [ ] 旧栈数据是否迁移/公告（若切流，老用户处置方案未定）

## 6. 合规与文案

- [ ] 免责短句三处已固化（落地页/首页/报告，`components/base/compliance-disclaimer.tsx`）——**最终措辞待 Kaiming 终审**
- [ ] 注册页条款与 18 岁确认可用；TermsConsent 落库验证
- [ ] 隐私政策/用户协议正文链接（当前仅勾选交互，正文托管位置未定 ⏸）

## 7. 监控与告警（首发最小）

- [ ] `GET /api/health` 外部拨测（UptimeRobot 等）
- [ ] 服务器磁盘/容器重启告警；dev-log 仅本地（生产无）
- [ ] GHCR 镜像拉取凭证不过期（PAT 期限检查）

## 8. 上线后第一小时冒烟脚本（人工）

1. 注册新账号 → OTP → 建账向导 → 首页正常态（新建计划/录入买入两入口）
2. 录入买入 → 建计划并分配 → 列表进度条 → 详情双进度
3. 记录使用 → 完成确认 → 报告页成本摘要 + 免责声明可见
4. 账户页「计划分配」只读表金额与摘要卡对账
5. AI 助手一问（若启用）；行情页图表加载
