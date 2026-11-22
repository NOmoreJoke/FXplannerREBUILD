import nestjsConfig from "../../packages/eslint-config/nestjs.js";

export default [
	{
		name: "chat/ignores",
		ignores: [
			"dist/**",
			"node_modules/**",
			"coverage/**",
			"prisma/migrations/**",
		],
	},
	...nestjsConfig,
];
