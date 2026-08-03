---
name: archive
description: 归档当前变更，提取可复用规则，更新 CHANGELOG
---

# 归档流程

## 1. 生成会话总结
在 `changes/{功能名}/会话总结.md` 记录：
- 遇到的问题（现象 + 原因）
- 解决方案
- 可复用的模式

## 2. 提取规则（如需要）
**规则 = AI 必须遵循的强制约束**

- 只写"必须/禁止"，不写原因和示例
- 位置：`.claude/rules/{领域}/{模块}/xx.md`
- **创建前先给用户看，确认后再写**

## 3. 更新 AI 开发能力迭代记录
追加到 `AI开发能力迭代记录.md`

## 4. 归档文件夹
```bash
mv changes/{功能名} changes/archived/YYYY-MM-DD-{功能名}
```

## 5. 更新 CHANGELOG.md
在 `[Unreleased]` 上方插入新条目
