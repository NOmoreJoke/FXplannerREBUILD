# @fxplanner-new/eslint-config

共享的 ESLint 配置，为 LingJi Monorepo 提供统一的代码检查规则。

## 配置文件

- **base.js** - 通用基础规则，所有项目的共同配置
- **nextjs.js** - Next.js 项目专用（继承 base + Next.js 规则）
- **nestjs.js** - NestJS 项目专用（继承 base）

## 使用方式

### Next.js 项目

创建 `.eslintrc.js`：

```javascript
module.exports = {
  extends: ['@fxplanner-new/eslint-config/nextjs'],
  // 项目特定规则
  rules: {
    // 可以在这里覆盖规则
  },
};
```

### NestJS 项目

创建 `.eslintrc.js`：

```javascript
module.exports = {
  extends: ['@fxplanner-new/eslint-config/nestjs'],
  // 项目特定规则
  rules: {
    // 可以在这里覆盖规则
  },
};
```

## 核心规则说明

### 通用规则（base.js）

- `@typescript-eslint/no-explicit-any: warn` - 警告使用 any 类型
- `@typescript-eslint/no-unused-vars: error` - 禁止未使用的变量（以 `_` 开头的除外）
- `@typescript-eslint/no-non-null-assertion: warn` - 警告非空断言（`!`）

### Next.js 规则（nextjs.js）

- 继承 Next.js 官方推荐配置
- 对 React Hooks 依赖检查设为警告

### NestJS 规则（nestjs.js）

- 针对装饰器和依赖注入优化
- 允许接口名前缀（如 `IUserService`）

## 运行 ESLint

在根目录的 `package.json` 中添加脚本：

```json
{
  "scripts": {
    "lint": "turbo run lint",
    "lint:fix": "turbo run lint:fix"
  }
}
```

在子项目的 `package.json` 中：

```json
{
  "scripts": {
    "lint": "eslint . --ext .ts,.tsx",
    "lint:fix": "eslint . --ext .ts,.tsx --fix"
  }
}
```

## 自定义规则

如果某个项目需要特定规则，直接在项目的 `.eslintrc.js` 中覆盖：

```javascript
module.exports = {
  extends: ['@fxplanner-new/eslint-config/nextjs'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off', // 允许使用 any
  },
};
```

## 忽略文件

在项目根目录创建 `.eslintignore`：

```
node_modules
dist
.next
.turbo
*.config.js
```

## 开发指南

### 修改规则

修改 `base.js` 会影响所有项目：

1. 确保规则合理且团队达成共识
2. 在根目录运行 `bun run lint` 验证所有项目
3. 渐进式修改：先 warn 再 error

### 添加新框架配置

如需支持新框架（如 Vue、React Native）：

1. 创建新的 JS 文件（如 `vue.js`）
2. 继承 `base.js` 并添加框架特定规则
3. 更新 `package.json` 的 `files` 和 `dependencies`
4. 更新此 README

## 注意事项

- 首次启用 ESLint 可能会有大量警告/错误，建议逐步修复
- 可以使用 `// eslint-disable-next-line` 临时禁用某行规则
- 生产代码不应包含 `eslint-disable` 注释
