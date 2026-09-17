---
"@fxplanner-new/chat": minor
"@fxplanner-new/chat-web": minor
---

首次设置重构（登录即用 + 最小建账 + 偏好后置）：

- 登录页前置年龄与条款两项勾选，未勾选拦截发码与登录；登录成功自动提交 consents 并按建账状态分流
- 新增两步建账向导：本位币一次确认（永久锁定），初始持仓选填（无有效报价不得入账、任一失败整单回滚）
- 新增 POST /api/onboarding/initial-holdings 建账后补录（每币种仅一笔，首页引导卡入口）
- 新增 GET/PATCH /api/settings：地区/语言/准备偏好/提醒随时可改，本位币只读
- GET /api/home/state 新增 hasInitialHoldings 供补录引导分流
