# @fxplanner-new/contracts

跨服务共享的类型定义和 Schema。

## 目录结构

按功能模块组织：

```
src/
├── ai/                # AI 相关
│   ├── provider.schema.ts       # AI 服务提供商（OpenAI、Anthropic 等）
│   ├── capability.schema.ts     # AI 能力定义（聊天、图像生成等）
│   ├── chat-message.schema.ts   # 聊天消息格式
│   └── image-generation.schema.ts # 图像生成相关
├── conversation/      # 会话管理
│   └── conversation.schema.ts   # 意图识别、任务、消息、SSE 事件
├── canvas/           # 画布坐标和操作
│   ├── canvas-state.schema.ts        # 画布状态
│   ├── canvas-op.schema.ts           # 画布操作
│   └── canvas-coordinates.schema.ts  # 坐标系统
├── poster/           # 海报配置
│   └── poster-config.ts         # 海报样式常量（颜色、字体等）
├── model/            # 模型配置
│   └── model-config.schema.ts   # 聊天和图像模型配置
└── index.ts          # 统一导出入口
```

## 命名约定

### 文件后缀规则

- **`*.schema.ts`** - 可运行时校验的 zod schema
  - 导出 `*Schema` 常量（zod 对象）
  - 导出 infer 的 TypeScript 类型
  - 用于前后端数据验证和类型安全

- **`*.types.ts`** - 纯 TypeScript 类型/接口
  - 仅编译时类型定义
  - 不包含运行时验证逻辑

- **`*.ts`** - 其他内容
  - 常量配置（如 `poster-config.ts`）
  - 工具函数
  - 枚举等

### 示例

```typescript
// conversation.schema.ts - zod schema
import { z } from "zod";

export const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

export type Message = z.infer<typeof MessageSchema>;
```

```typescript
// poster-config.ts - 常量配置
export const POSTER_COLORS = {
  canvas: {
    background: "#f3f5f7",
  },
  artboard: {
    background: "#ffffff",
    stroke: "#ddd",
  },
} as const;

export type PosterColors = typeof POSTER_COLORS;
```

## 使用方式

### 基本引用

```typescript
// 前端或后端引用
import { MessageSchema, type Message } from '@fxplanner-new/contracts';
import { POSTER_COLORS } from '@fxplanner-new/contracts';

// 使用 zod schema 验证数据
const result = MessageSchema.safeParse(data);
if (result.success) {
  const message: Message = result.data;
}

// 使用常量
const bgColor = POSTER_COLORS.canvas.background;
```

### 按模块引用（可选）

如果需要明确来源，也可以指定子路径：

```typescript
import { MessageSchema } from '@fxplanner-new/contracts/conversation/conversation.schema';
import { POSTER_COLORS } from '@fxplanner-new/contracts/poster/poster-config';
```

但推荐通过 `index.ts` 统一导出，保持导入简洁。

## 添加新类型

### 步骤

1. **确定模块归属** - 选择合适的模块目录（ai/conversation/canvas/poster/model），或新建模块目录
2. **选择文件后缀** - 根据内容选择 `.schema.ts`、`.types.ts` 或 `.ts`
3. **编写类型定义** - 如果是 schema，使用 zod；如果是纯类型，使用 TypeScript interface/type
4. **更新 index.ts** - 在 `src/index.ts` 中添加导出
5. **运行验证** - 执行 `bun run typecheck` 确保类型正确

### 示例：添加新的用户配置 schema

```typescript
// 1. 创建文件 src/user/user-config.schema.ts
import { z } from "zod";

export const UserConfigSchema = z.object({
  theme: z.enum(["light", "dark"]),
  language: z.string(),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

// 2. 更新 src/index.ts
export * from "./user/user-config.schema";
```

## 开发指南

### 类型安全原则

- 优先使用 zod schema，提供运行时验证
- 避免使用 `any`，用 `unknown` 代替
- 为所有公共 API 提供明确的类型定义

### 版本兼容

- 添加字段时使用 `.optional()` 保持向后兼容
- 删除字段前确认所有引用处已更新
- 修改字段类型需要协调前后端同步更新

### 命名规范

- Schema 常量：`*Schema`（如 `MessageSchema`）
- 类型名：与 Schema 对应，去掉 Schema 后缀（如 `Message`）
- 常量配置：全大写蛇形命名（如 `POSTER_COLORS`）

## 相关文档

- [项目架构](./.claude/rules/architecture.md)
- [代码规范](./.claude/rules/coding-style.md)
