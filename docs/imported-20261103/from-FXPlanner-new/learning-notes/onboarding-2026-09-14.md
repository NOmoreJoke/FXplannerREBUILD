# onboarding（新手引导 / 首次设置向导）

**提问时间：** 2026-09-14

**问题：** onboarding 中文意思是什么？

---

## 核心要点

- 直译「入职引导」，互联网产品语境通译 **新手引导 / 首次设置向导**
- 指用户注册登录后**第一次使用产品**时的引导流程（区别于日常使用中的功能提示）
- 术语族：`sign-up` 注册、`sign-in / login` 登录、`onboarding` 首次使用引导、`product tour` 功能介绍
- FXPlanner 中 = 登录后首次设置流程：地区语言 → 18 岁/条款确认 → 本位币 → 已有外币 → 提醒开关
- 对应代码：后端 `services/chat/src/onboarding` 模块、`OnboardingDraft` 表（草稿 30 天续填）、前端内嵌向导（无独立路由）

## 相关概念

- OTP（One-Time Password）：一次性验证码，本项目邮箱验证码登录的基础
- 数据库设计上 onboarding 拆成三张表：`UserSettings`（正式偏好）、`OnboardingDraft`（草稿）、`TermsConsent`（合规确认）

---

**标签：** #术语 #onboarding #产品概念
