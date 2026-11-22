/**
 * lint-staged 配置：pre-commit 质检
 * 用函数形式返回命令，避免 lint-staged 把暂存文件名追加给 turbo。
 */
export default {
  // 有 TS/TSX 文件变更时执行确定性静态护栏（ESLint 架构边界 + 结构守卫 + 全仓 typecheck）
  '*.{ts,tsx}': () => ['bun run lint', 'bun run typecheck'],
};
