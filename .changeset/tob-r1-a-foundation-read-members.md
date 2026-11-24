---
"@fxplanner-new/chat": minor
"@fxplanner-new/chat-web": minor
---

ToB R1 Part A（组织地基、只读隔离与成员/审计闭环）：

- **数据层（MIG-A/MIG-B）**：新增 Organization/Membership/Invitation/Settings/AuditLog/ReminderRead 六表与 11 张业务表可空组织列（增量迁移，唯一活跃 Owner 由部分唯一索引保护）；MIG-B 幂等默认组织回填 + §12.3 一致性核对 CLI（备份库演练 3760 项检查 0 差异、二次执行幂等）。
- **鉴权（AUTH-01/02）**：纯函数 RBAC 策略真源（5 角色 × 28 权限点）；OrganizationContextGuard/PermissionGuard/BusinessOrgScopeGuard（兼容窗口唯一默认组织回落，多组织缺头 400；降权秒级生效）；跨组织/非成员统一 404 不泄露存在性。
- **只读隔离（LEDGER-01 读侧）**：account/plan/transaction/usage/correction/report/home/settings/reminder/ai 全部业务 GET 按组织作用域查询（组织行跨成员共享 + 过渡期 NULL 行仅本人可见）；注册兜底创建默认组织。
- **成员与邀请（MEM-01/02）**：邀请状态机（token 单向 SHA-256 落库、7 天有效期、幂等复用、并发接受单成员关系）；成员角色调整/移除（DISABLED 留痕）/退出（最后 Owner 409）/所有权转移（先降后升事务顺序）。
- **审计（AUDIT-01..03）**：业务同事务审计写入 + 敏感字段脱敏 + 只读分页查询（无任何写删接口）。
- **前端（W20/W21）**：组织上下文 store/transport/Query Key 组织隔离与切换缓存清理；组织切换器、成员/邀请/审计管理页、受邀接受页；组织路由分流（单组织直达/多组织选择/无组织引导）。
