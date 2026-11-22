const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");

/**
 * ESLint 9 Flat Config 基础规则（@fxplanner-new/eslint-config/base）
 *
 * 覆盖全仓 TypeScript / TSX 文件的解析与核心静态约束；
 * 与根 eslint.config.mjs 架构护栏正交，可被子包各自组合。
 */
module.exports = [
	{
		name: "fxplanner/base-ignores",
		ignores: [
			"**/node_modules/**",
			"**/dist/**",
			"**/.next/**",
			"**/coverage/**",
			"**/*.d.ts",
		],
	},
	{
		name: "fxplanner/base-typescript",
		files: ["**/*.{ts,tsx,mts,cts}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
				ecmaFeatures: {
					jsx: true,
				},
			},
		},
		plugins: {
			"@typescript-eslint": tsPlugin,
		},
		rules: {
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-non-null-assertion": "warn",
			"@typescript-eslint/ban-ts-comment": [
				"error",
				{
					"ts-ignore": true,
					"ts-nocheck": true,
					"ts-check": false,
					"ts-expect-error": "allow-with-description",
					minimumDescriptionLength: 10,
				},
			],
		},
	},
];
