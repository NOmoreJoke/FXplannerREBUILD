import { describe, expect, it } from "vitest";
import {
	escapeHtml,
	renderVerifyCodeHtml,
	VERIFY_CODE_SUBJECT,
} from "./email-otp.templates";

describe("VERIFY_CODE_SUBJECT", () => {
	it("主题带品牌前缀", () => {
		expect(VERIFY_CODE_SUBJECT).toBe("【FXPlanner】验证码");
	});
});

describe("escapeHtml", () => {
	it("转义 HTML 特殊字符（防模板变量注入）", () => {
		expect(escapeHtml(`<script>&"'</script>`)).toBe(
			"&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;",
		);
	});
});

describe("renderVerifyCodeHtml", () => {
	it("HTML 包含验证码、品牌名与有效期提示", () => {
		const html = renderVerifyCodeHtml("654321");
		expect(html).toContain("654321");
		expect(html).toContain("FXPlanner");
		expect(html).toContain("10 分钟");
	});

	it("验证码被 HTML 转义后渲染", () => {
		// 防御性：即便未来验证码混入特殊字符也不应原样输出
		const html = renderVerifyCodeHtml(`<b>123456`);
		expect(html).not.toContain(`<b>123456`);
		expect(html).toContain("&lt;b&gt;123456");
	});
});
