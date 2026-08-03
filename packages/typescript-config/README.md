# @fxplanner-new/typescript-config

共享的 TypeScript 配置，为 LingJi Monorepo 提供统一的编译选项。

## 配置文件

- **base.json** - 通用基础配置，所有项目的共同选项
- **nextjs.json** - Next.js 项目专用（继承 base）
- **nestjs.json** - NestJS 项目专用（继承 base）

## 使用方式

在子项目的 `tsconfig.json` 中继承对应的配置：

### Next.js 项目

```json
{
  "extends": "@fxplanner-new/typescript-config/nextjs.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./*"]
    }
  }
}
```

### NestJS 项目

```json
{
  "extends": "@fxplanner-new/typescript-config/nestjs.json",
  "compilerOptions": {
    "baseUrl": "./"
  }
}
```

## 核心配置说明

### base.json

- `target: ES2022` - 编译目标为 ES2022
- `strict: true` - 启用所有严格类型检查
- `skipLibCheck: true` - 跳过声明文件检查，加速编译
- `esModuleInterop: true` - 支持 CommonJS/ES Module 互操作

### nextjs.json

- 增加 `DOM` 相关 lib
- `jsx: preserve` - 保留 JSX 语法交给 Next.js 处理
- 集成 Next.js TypeScript 插件

### nestjs.json

- `module: commonjs` - NestJS 使用 CommonJS 模块
- `emitDecoratorMetadata: true` - 支持装饰器元数据
- `experimentalDecorators: true` - 启用装饰器语法

## 修改配置

如果需要覆盖某些选项，在子项目的 `tsconfig.json` 中直接指定即可：

```json
{
  "extends": "@fxplanner-new/typescript-config/nextjs.json",
  "compilerOptions": {
    "target": "ES2020"  // 覆盖 base 中的 ES2022
  }
}
```

## 开发指南

### 添加新配置

如果需要为新的框架添加配置（如 Vue、React Native 等）：

1. 创建新的 JSON 文件（如 `vue.json`）
2. 继承 `base.json` 并添加框架特定选项
3. 更新 `package.json` 的 `files` 字段
4. 更新此 README

### 修改基础配置

修改 `base.json` 会影响所有项目，需要：

1. 在根目录运行 `bun run typecheck` 验证所有项目
2. 确保不会破坏现有代码
3. 提交前与团队沟通
