import { describe, expect, it } from "vitest";
import { maskSensitiveText } from "./mask";

describe("maskSensitiveText（前端）", () => {
	it("脱敏 Bearer / query token / JSON 敏感字段", () => {
		expect(maskSensitiveText("Bearer abc.def")).toBe("Bearer ***");
		expect(maskSensitiveText("/api/x?token=secret1&a=1")).toBe(
			"/api/x?token=***&a=1",
		);
		expect(maskSensitiveText('{"password":"123456"}')).toBe(
			'{"password":"***"}',
		);
	});

	it("普通文本不受影响", () => {
		expect(maskSensitiveText("TypeError: boom")).toBe("TypeError: boom");
	});
});
