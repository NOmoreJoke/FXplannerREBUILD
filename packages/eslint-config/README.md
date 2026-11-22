# @fxplanner-new/eslint-config

共享的 ESLint 9 Flat Config 配置与插件依赖集合，为 FXplannerREBUILD Monorepo 提供统一的代码质量基线。

## 职责定位

- **做什么（职责）**：
  - 集中托管 ESLint 9、`@typescript-eslint/{parser,eslint-plugin}` 与 `eslint-config-next` 插件依赖（供根 `eslint.config.mjs` 及各子包 `eslint.config.mjs` 共用，避免重复安装）。
  - 提供 `base.js`（通用 TypeScript 规则）、`nestjs.js`（NestJS 后端 + 测试放宽）、`nextjs.js`（Next.js App Router + React Hooks）三套 Flat Config。
- **不做什么（边界 / 非目标）**：
  - 不包含仓级跨目录单向依赖规则、裸 `useEffect` / 定时器硬门禁或 `money` 零 IO 边界检查（这些架构护栏归根 `eslint.config.mjs`）。
  - 不执行跨包 Git diff 检查或调度运行（归 `scripts/lint-observe.ts`）。
- **为何独立成包**：
  - 在 Bun + Turbo Workspace 中统一锁定 ESLint 9 插件版本，并确保 `infra/compose/Dockerfile.*` 仅拷贝必要依赖清单即可复现一致环境，避免业务包直接背负 lint 插件树。

## 配置文件

- **base.js** — 通用 TS/TSX 规则：`@typescript-eslint/no-unused-vars`（`^_` 忽略，error）、`ban-ts-comment`（error）、`no-explicit-any`（warn）、`no-non-null-assertion`（warn）。
- **nestjs.js** — 继承 `base.js`，对 `*.spec.ts` 与 `test/**/*.ts` 放宽 `no-explicit-any` / `no-non-null-assertion`。
- **nextjs.js** — 继承 `base.js`，叠加 `react-hooks/rules-of-hooks`（error）、`react-hooks/exhaustive-deps`（warn）、`@next/next/no-img-element`（warn）、`@next/next/no-html-link-for-pages`（error），并对 `*.spec.*` / `*.test.*` 放宽测试断言。

## 使用方式（ESLint 9 Flat Config）

### NestJS 项目（`services/chat/eslint.config.mjs`）

```js
import nestjsConfig from "../../packages/eslint-config/nestjs.js";

export default [
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "prisma/migrations/**"] },
  ...nestjsConfig,
];
```

### Next.js 项目（`clients/chat-web/eslint.config.mjs`）

```js
import nextjsConfig from "../../packages/eslint-config/nextjs.js";

export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "lib/api/schema.gen.ts",
      "next-env.d.ts",
    ],
  },
  ...nextjsConfig,
];
```

## 渐进式 `observe` 模式（`scripts/lint-observe.ts`）

- 根目录 `bun run lint` 先运行结构/架构硬门禁（`lint:eslint` + `check:structure`），再经 `bun run lint:observe`（`turbo run lint`）调用 `scripts/lint-observe.ts`：
  1. 对目标包全量运行包内 Flat Config 并打印存量 warning/error 基线统计（未修改的存量文件不阻断提交）；
  2. 对比当前分支相对 `dev`（回退 `origin/dev`）的变更文件及未提交改动：
     - **已修改的 `.ts/.tsx`**：禁止出现 `error`（`errorCount > 0` 即失败）；
     - **新增的 `.ts/.tsx`**：`0 error, 0 warning`（任何新增告警/错误即失败）。
