---
"@fxplanner-new/chat": patch
"@fxplanner-new/chat-web": patch
---

修复计划排期预览未计入「已有外币」持有量，并回补目标币种校验：

- 排期预览（POST /plans/schedule-preview）新增可选 `allocatedAmount`（计入已有外币），分批总额按「目标 − 该值」计算，与创建口径完全一致；缺省 "0" 时行为与修复前逐位一致
- 创建计划回补校验：目标币种不得与本位币相同（preview 未建账时跳过，create 恒拦，400 INVALID_PLAN_PARAMS）
- 前端创建表单：本位币选项置灰标注；计入 ≥ 目标时直接本地提示且创建按钮禁用，不再发请求
