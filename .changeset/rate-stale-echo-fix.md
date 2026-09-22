---
"@fxplanner-new/chat": patch
"@fxplanner-new/chat-web": patch
---

修复汇率查询高频停留在「获取中」：最新报价接口引入陈旧回显（stale-while-revalidate）：

- 后端 GET /rates/latest：超窗但库内有报价时立即返回旧值（fresh=false 如实标注），并后台异步回源落库（单飞复用、失败仅告警不上抛）；库内无报价（冷启动）或 refresh=true 仍同步整组回源
- refresh=true 强一致语义收窄至确认页锁数/手动刷新；错误兜底仍不以旧报价冒充新鲜值
- 前端三处首拉（录入页汇率参考卡 / useLatestRates / onboarding 持仓核对）不再强制回源，进页优先回显定时任务已落库报价（30 分钟粒度），换币种集合仍强制取新
