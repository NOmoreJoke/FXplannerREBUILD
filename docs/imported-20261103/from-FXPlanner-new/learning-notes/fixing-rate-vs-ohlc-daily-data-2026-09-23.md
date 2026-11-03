# 汇率定盘价（Fixing / Reference Rate）与日线数据机制

**提问时间：** 2026-09-23

**问题：** 汇率定时获取失败怎么办？历史数据精度只有「天」吗？每日那个价格是最高价还是最低价，术语叫什么？

---

## 核心要点

- FXPlanner 汇率机制分两层：cron 每 30 分钟攒**实时点**（CNY 视角 15 币种，多源路由），getHistory 查询时**查库优先、缺口按需回源**（仅 frankfurter 有真实历史）
- 失败处理三板斧：cron 失败下轮自然重试（30 分钟）、历史回源失败进**负缓存**（10 分钟不再打外网）、并发请求**单飞**合并成一次外呼
- 缺口：无失败台账、无补偿回填任务；且 abc/er-api 源上没有历史数据，断档的历史永远补不回，仅 frankfurter 覆盖的 14 币种可事后补
- 历史精度最大为**天**：ECB 参考汇率每日一次定价，公开免费渠道无分钟级外汇历史（tick 级需路透/彭博等付费源）
- 每日那个价格不叫最高价/最低价——日线 OHLC（开高低收）里它是**收盘价（Close）**；「每天固定时点定一次价」的机制叫**定盘价（fixing）**，ECB 官方名称是**参考汇率（reference rate）**，每天中欧时间 16:00 定盘
- getHistory 窗口终点截到「今天 UTC 零点」（rate.service.ts:273）：当日盘中点明天才进历史窗口，保证日线序列纯净

## 关键示例

```ts
// rate.service.ts:273-275 历史窗口：按 UTC 自然日对齐
const end = this.startOfUtcDay(new Date());                  // 今天 00:00 UTC
const start = new Date(end.getTime() - period * 86_400_000); // 7/30/90/365 天前
```

## 相关概念

- 定盘价（fixing）vs 收盘价（close）：fixing 是定价机制，close 是它在 OHLC 序列中的角色
- 负缓存（negative cache）：空结果也缓存，防止对「确定没有的数据」反复外呼
- 单飞（single-flight）：并发同请求合并为一次外呼，其余共享结果
- 回填（backfill）：事后从有历史能力的源补缺口（frankfurter 可补、abc/er-api 不可补）

---

**标签：** #汇率 #定盘价 #日线数据 #OHLC #负缓存 #单飞 #数据回填
