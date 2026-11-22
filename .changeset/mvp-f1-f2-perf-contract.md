---
"@fxplanner-new/chat": minor
"@fxplanner-new/chat-web": minor
"@fxplanner-new/eslint-config": minor
---

完成 Goal #2（MVP-F1/F2 性能收敛、契约清零与工具链治理）：
- 汇率最新可发布报价改写为 PostgreSQL `CROSS JOIN LATERAL` 常量行索引扫描（confirmed/unconfirmed 两段短路 + `EXPLAIN (ANALYZE, BUFFERS)` 验证）；
- 认证身份请求级 WeakMap 复用与 `DataRequestLockGuard` 单次 `data_requests` 查询合并，删除用户即时失效缓存且非白名单端点库异常 fail-closed；
- 前端统一 `queryKeys` 工厂（预留 `withOrgScope` 多租户前缀）、建账/锁定期请求门控与预期 409/403 遥测降噪；
- 补齐 `Account`/`Plan`/`AI` Swagger DTO 注解，清零 `clients/chat-web/lib/api/` 全量手写 REST 影子 DTO；
- 升级 `@fxplanner-new/eslint-config` 至 ESLint 9 Flat Config，落地 `scripts/lint-observe.ts` 渐进式门禁与 CI `fetch-depth: 0`，移除 9 个零引用依赖，对齐 `PlanChangeLog` Prisma relation 并修复测试用户清理 `cleanupUser` 孤儿残留。
