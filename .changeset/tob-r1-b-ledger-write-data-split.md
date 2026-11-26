---
"@fxplanner-new/chat": minor
"@fxplanner-new/chat-web": minor
---

ToB R1 Part B（账本写操作组织化、防呆与数据权利双域拆分 · W22–W28）：

- **个人/组织设置分离与独立建账（W22）**：`GET/PATCH /settings/personal`（个人展示偏好，无关组织角色）与组织 `GET/PATCH /settings`（按字段鉴权 + 持锁后内联角色复验）拆库；`OnboardingService` 组织级幂等与并发锁，所有权转移先固化回落 `OrganizationSettings` 并保留 `created_by_id`/`updated_at`。
- **账本写操作 100% Actor 化与共享 FIFO（W23–W24）**：`transaction`、`plan`（排期/调整/完成/取消/重启）、`usage`（按组织 FIFO 跨成员消耗成本批次）、`correction`（交易/持仓/使用历史重放与跨成员乐观并发）全部改走 `OrganizationContextGuard -> OrganizationLockGuard -> PermissionGuard`、`lockOrganizationForActor` 锁内重读角色、`lockOrgLedgerAccounts` 与 `AuditService.recordInTx` 同事务提交/失败回滚；`MIG-C` 切换组织维度唯一索引。
- **提醒、报告与 AI 组织隔离（W25）**：新增成员级 `ReminderRead`（跨成员已读独立，不窜改他人）；对称纳入兼容窗口计划占用核验 `ReportService`；`AiConversation` 全端点与 `rate-tool` 配额/写工具组织化隔离。
- **数据权利双域拆分与双锁守卫（W26–W27 + D6 加固）**：`DataRequest` 物理拆分个人端点 `/api/data-requests/*`（仅 `EXPORT`/`DELETION`，导出绝不泄露账本，个人注销对存活默认组织先做最后 Owner 拦截、锁内收口 `NULL` 存量行后再过户与零残留校验）与组织端点 `/api/organizations/current/data-requests/*` + `DELETE /api/organizations/current`；落库 DB `CHECK` 约束；修复 `07-plan-allocations.csv` 计划目标币种精度并增加 `"币种"` 列；中和 CSV 配方公式注入；`PersonalAccountLockGuard` 与 `OrganizationLockGuard` 合并单条 `findMany <= 1` SELECT 与导出下载实时降权/跨组织校验。
- **前端能力感知与双域 UI（W28）**：`useOrganizationCapabilities`（仅内存实时读取、fail-closed）、`resolveLedgerQueryGate`（未建账零 409 提醒噪声）、设置与数据权利双域拆分、`/data-requests` 纯路径兼容与 `409 LAST_OWNER_REQUIRED` 引导、5 领域写入口门控、`OrganizationPicker` 退出登录入口及组织删除失败 Toast 反馈。
