# 目标币种 vs 本位币（及"不能一致"校验）

**提问时间：** 2026-09-21

**问题：** "创建计划时目标币种不能和本位币一致"是什么意思？

---

## 核心要点

- 本位币（baseCurrency）：onboarding 建账时一次性设定，存 `UserSettings.base_currency`，无更新写路径；是记账主币种（资产折算/报表/成本基准）。
- 目标币种（targetCurrency）：每条换汇计划想攒够的外币，如"换 5 万美元"→ USD；限定在 money 包 15 币种内。
- "一致"= 建计划时选的目标币种 === settings 里的本位币（如本位币 HKD 的用户建 HKD 计划），等于"用港币买港币"，不是换汇。
- 两者一致时汇率恒为 1，排期/成本/缺口计算全部退化；记账还会把本位币重复算成"换入"。
- 当前代码缺口：`parsePlanParams` 未比对 baseCurrency，`create()` 查 settings 也只 select 了 userId，拿不到 baseCurrency。

## 关键代码

```
services/chat/src/plan/plan.service.ts:207   create() 查 settings 只取 userId
services/chat/src/plan/plan.service.ts:1177  parsePlanParams 仅校验 15 币种内
services/chat/prisma/schema.prisma:105       UserSettings.base_currency
```

## 相关概念

- 本位币没有余额（base-currency-has-no-balance）
- Goal vs Plan

---

**标签：** #本位币 #换汇计划 #校验
