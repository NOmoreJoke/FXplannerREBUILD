import nextjsConfig from "../../packages/eslint-config/nextjs.js";

export default [
	{
		name: "chat-web/ignores",
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
