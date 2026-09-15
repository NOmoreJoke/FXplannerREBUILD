import { vi } from "vitest";
import type { OtpChannel } from "../../src/auth/otp/otp-channel";

export interface CapturingEmailOtpChannel extends OtpChannel {
	/** 已捕获的验证码（按发送顺序） */
	sentCodes: string[];
	/** 最近一次发出的验证码 */
	lastCode(): string | undefined;
}

/**
 * 捕获验证码的 fake email OTP 渠道（不外呼 Resend）。
 * 配合 createTestApp 的 configure 钩子 override OTP_CHANNELS 使用。
 */
export function createCapturingEmailOtpChannel(): CapturingEmailOtpChannel {
	const sentCodes: string[] = [];
	return {
		channel: "email",
		send: vi.fn(async (_target: string, code: string) => {
			sentCodes.push(code);
		}),
		sentCodes,
		lastCode: () => sentCodes.at(-1),
	};
}
