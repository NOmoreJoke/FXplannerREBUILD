/**
 * @langchain/langgraph subpath 类型桥接（ai-assistant 技术方案 §5.1）。
 *
 * 背景：项目共享 tsconfig（packages/typescript-config/nestjs.json）锁定
 * moduleResolution: "node"，不解析 package.json 的 exports 子路径，导致
 * `import "@langchain/langgraph/prebuilt"` 无法获得类型；而该共享配置不在
 * 本模块改动范围内。包运行时（Bun / vitest）均按 exports 正常解析，
 * 仅缺类型——此 shim 将 subpath 映射到 dist 物理类型文件（相对路径不受
 * exports 封装限制）。
 *
 * 若未来 moduleResolution 升级为 node16/bundler，本文件可直接删除。
 */
declare module "@langchain/langgraph/prebuilt" {
	export { createReactAgent } from "../../../../node_modules/@langchain/langgraph/dist/prebuilt/index.js";
}
