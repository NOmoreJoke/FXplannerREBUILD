const baseConfig = require("./base");

/**
 * ESLint 9 Flat Config — NestJS 后端共享配置（@fxplanner-new/eslint-config/nestjs）
 */
module.exports = [
	...baseConfig,
	{
		name: "fxplanner/nestjs-spec-relax",
		files: ["**/*.spec.ts", "test/**/*.ts"],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
		},
	},
];
