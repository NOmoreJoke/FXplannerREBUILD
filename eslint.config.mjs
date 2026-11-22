import { createRequire } from 'node:module';

const require = createRequire(new URL('./packages/eslint-config/package.json', import.meta.url));
const nextConfigRequire = createRequire(require.resolve('eslint-config-next/package.json'));
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const reactHooksPlugin = nextConfigRequire('eslint-plugin-react-hooks');

const NODE_IO_BUILTINS = [
  'child_process',
  'cluster',
  'dgram',
  'dns',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'readline',
  'tls',
  'worker_threads',
];

// 既有存量 useEffect 文件过渡白名单（禁止继续扩张；新建业务文件严禁裸写 useEffect）
const LEGACY_USE_EFFECT_FILES = [
  'clients/chat-web/app/(protected)/corrections/new/page.tsx',
  'clients/chat-web/app/(protected)/home/page.tsx',
  'clients/chat-web/app/(protected)/layout.tsx',
  'clients/chat-web/app/(protected)/market/page.tsx',
  'clients/chat-web/app/(protected)/onboarding/page.tsx',
  'clients/chat-web/app/(protected)/plans/new/page.tsx',
  'clients/chat-web/app/(protected)/transactions/new/page.tsx',
  'clients/chat-web/components/business/chat/message-list.tsx',
  'clients/chat-web/components/business/chat/model-selector.tsx',
  'clients/chat-web/components/business/onboarding/wizard-step-holdings.tsx',
  'clients/chat-web/components/business/plan/plan-adjust-dialog.tsx',
  'clients/chat-web/components/business/report/plan-report-print-view.tsx',
  'clients/chat-web/components/business/settings/preferences-form.tsx',
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/coverage/**',
      'e2e/test-results/**',
      'clients/chat-web/lib/api/schema.gen.ts',
    ],
  },
  {
    files: [
      'clients/chat-web/**/*.{ts,tsx}',
      'services/chat/src/**/*.ts',
      'packages/money/src/**/*.ts',
      'packages/dev-log-server/src/**/*.ts',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooksPlugin,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
    },
  },
  // 跨端契约隔离：前端禁止直接引入后端源码
  {
    files: ['clients/chat-web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/services/chat/**'],
              message:
                '[契约红线] 前端禁止直接引入后端源码。共享类型必须经 bun run --cwd clients/chat-web generate:api 从 OpenAPI 生成，纯函数进 @fxplanner-new/money。',
            },
          ],
        },
      ],
    },
  },
  // 前端单向依赖红线：ui 禁止反向依赖 base / business（合并跨端契约禁令）
  {
    files: ['clients/chat-web/components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/services/chat/**'],
              message:
                '[契约红线] 前端禁止直接引入后端源码。共享类型必须经 bun run --cwd clients/chat-web generate:api 从 OpenAPI 生成，纯函数进 @fxplanner-new/money。',
            },
            {
              group: ['@/components/base/*', '@/components/base', '@/components/business/*', '../base/*', '../business/*'],
              message:
                '[架构红线] 组件依赖必须单向（business → base → ui），ui 原语禁止引入 base 或 business 组件。',
            },
          ],
        },
      ],
    },
  },
  // 前端单向依赖红线：base 禁止反向依赖 business（合并跨端契约禁令）
  {
    files: ['clients/chat-web/components/base/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/services/chat/**'],
              message:
                '[契约红线] 前端禁止直接引入后端源码。共享类型必须经 bun run --cwd clients/chat-web generate:api 从 OpenAPI 生成，纯函数进 @fxplanner-new/money。',
            },
            {
              group: ['@/components/business/*', '../business/*'],
              message:
                '[架构红线] 组件依赖必须单向（business → base → ui），base 组件禁止引入 business 组件。',
            },
          ],
        },
      ],
    },
  },
  // 前端禁止使用命令式定时器打时序补丁
  {
    files: ['clients/chat-web/app/**/*.{ts,tsx}', 'clients/chat-web/components/**/*.{ts,tsx}'],
    ignores: [
      'clients/chat-web/components/ui/**/*.{ts,tsx}',
      // 存量过渡：打印弹窗延迟触发 window.print()
      'clients/chat-web/components/business/report/plan-report-print-view.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name=/^(setTimeout|requestAnimationFrame|requestIdleCallback)$/], CallExpression[callee.object.name='window'][callee.property.name=/^(setTimeout|requestAnimationFrame|requestIdleCallback)$/]",
          message:
            '[根因修复] 禁止在页面/业务组件中使用 setTimeout/rAF/rIC 打时序补丁，请修复状态流、事件回调或交由受控 hook 处理。',
        },
      ],
    },
  },
  // 前端新页面与业务组件禁止裸写 useEffect（存量白名单逐步清零）
  {
    files: ['clients/chat-web/app/**/*.{ts,tsx}', 'clients/chat-web/components/**/*.{ts,tsx}'],
    ignores: [
      'clients/chat-web/components/ui/**/*.{ts,tsx}',
      ...LEGACY_USE_EFFECT_FILES,
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name=/^(setTimeout|requestAnimationFrame|requestIdleCallback)$/], CallExpression[callee.object.name='window'][callee.property.name=/^(setTimeout|requestAnimationFrame|requestIdleCallback)$/]",
          message:
            '[根因修复] 禁止在页面/业务组件中使用 setTimeout/rAF/rIC 打时序补丁，请修复状态流、事件回调或交由受控 hook 处理。',
        },
        {
          selector:
            "CallExpression[callee.name='useEffect'], CallExpression[callee.object.name='React'][callee.property.name='useEffect']",
          message:
            '[架构护栏] 新建页面/业务组件禁止裸写 useEffect。请优先使用派生状态、事件处理、React Query/Zustand，或封装到 clients/chat-web/hooks/。',
        },
      ],
    },
  },
  // packages/money 零 IO 纯函数红线
  {
    files: ['packages/money/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_IO_BUILTINS.map((mod) => ({
            name: mod,
            message: `[纯函数红线] packages/money 严禁引入 IO/环境模块 "${mod}"，该包仅允许零 IO 精度与舍入纯函数。`,
          })),
          patterns: [
            {
              group: ['node:*'],
              message:
                '[纯函数红线] packages/money 严禁引入 node:* IO 模块，该包仅允许零 IO 精度与舍入纯函数。',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: '[纯函数红线] packages/money 严禁发起网络请求（fetch）。',
        },
      ],
    },
  },
];
