const { createRequire } = require("node:module");
const baseConfig = require("./base");

const nextConfigRequire = createRequire(
	require.resolve("eslint-config-next/package.json"),
);
const nextPlugin = nextConfigRequire("@next/eslint-plugin-next");
const reactHooksPlugin = nextConfigRequire("eslint-plugin-react-hooks");

/**
 * ESLint 9 Flat Config — Next.js 前端共享配置（@fxplanner-new/eslint-config/nextjs）
 */
module.exports = [
	...baseConfig,
	{
		name: "fxplanner/nextjs-react",
		files: ["**/*.{ts,tsx,mts,cts}"],
		plugins: {
			"@next/next": nextPlugin.default ?? nextPlugin,
			"react-hooks": reactHooksPlugin.default ?? reactHooksPlugin,
		},
		rules: {
			"react-hooks/rules-of-hooks": "error",
			"react-hooks/exhaustive-deps": "warn",
			"@next/next/no-img-element": "warn",
			"@next/next/no-html-link-for-pages": "error",
		},
	},
	{
		name: "fxplanner/nextjs-spec-relax",
		files: ["**/*.spec.{ts,tsx}", "**/*.test.{ts,tsx}"],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
		},
	},
];
