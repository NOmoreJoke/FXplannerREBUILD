# @fxplanner-new/money

跨端共享的币种常量与金额/汇率精度计算纯函数库。

## 做什么（职责）

- 15 个支持币种的唯一事实来源（`CURRENCIES` / `CURRENCY_BY_CODE` / `getCurrency`），顺序即 sortOrder，接口下发与 Currency 表 seed 均以此为准；
- 金额精度标准（十进制全精度运算、最终结果按币种精度 ROUND_HALF_UP 舍入一次、正数舍 0 拦截、单笔上限 1e11）：
  - `roundToCurrency` / `assertNotRoundToZero` / `assertPositiveAmount` / `assertAmountLimit`；
- 汇率精度标准（1 外币 = X 本位币、采用汇率固定 8 位小数）：`roundRateTo8` / `assertValidRate` / `RATE_DECIMAL_PLACES`；
- 核心折算纯函数：
  - `finalAmountOf(principal, rate, dp)`：本金 × 汇率 → 折算金额；
  - `receivedAmountOf(principal, rate, dp)`：本金 ÷ 汇率 → 到账外币金额（买入填法 A）；
  - `impliedRate(principal, received, dp)`：本金 ÷ 到账 → 反算汇率（买入填法 B）；
- 类型化错误体系（`MoneyError` 基类 + `RoundToZeroError` / `AmountLimitExceededError` / `InvalidAmountError` / `InvalidRateError`），调用方按 code 或类型分支处理。

## 不做什么（边界 / 非目标）

- 零 IO：禁止读写文件/网络/数据库/时钟，禁止引入任何运行时环境依赖；
- 不含业务规则（如交易校验流程、账户余额语义），只提供纯计算与校验原语；
- 不做金额的格式化展示（千分位、符号等）；
- 不做舍入策略配置——舍入口径（ROUND_HALF_UP、币种 0/2 位、汇率 8 位）即标准，不接受调用方覆盖。

## 为何独立成包

金额精度规则必须在前端（录入互算、实时显示）与后端（权威校验、落库计算）之间保持单一事实来源，任何一侧私拷贝都会导致互算漂移与账实不一致。独立成零依赖纯函数包，可被两端以同一版本精确复用。
