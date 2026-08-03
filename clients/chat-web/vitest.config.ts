import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()], // 组件测试需要 JSX/TSX 转换
  test: {
    environment: "jsdom", // React 组件测试需要 jsdom
    passWithNoTests: false,  // 强制要求至少有一个测试文件
    include: ["**/*.spec.ts", "**/*.spec.tsx"],  // 包含 .tsx 文件
    globals: true, // 启用全局 API (vi, describe, it, expect)
    // 注意：使用 `bun test` 直接运行可能导致 vi.useFakeTimers 等 API 不可用
    // 请使用 `bun run test` 或 `npx vitest run` 执行测试
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
