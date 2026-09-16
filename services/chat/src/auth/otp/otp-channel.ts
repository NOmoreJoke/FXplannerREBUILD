import type { OtpChannelType } from "./dto/send-otp-code.dto";

export type { OtpChannelType } from "./dto/send-otp-code.dto";

export interface OtpChannel {
	readonly channel: OtpChannelType;
	/**
	 * 开发模拟模式：未接入真实供应商时为 true。
	 * 此时 send() 只打日志不真正发送，OtpService 会在发码响应中附带 devCode 供本地联调/E2E 使用。
	 */
	readonly devMode?: boolean;
	send(target: string, code: string): Promise<void>;
}

export const OTP_CHANNELS = Symbol("OTP_CHANNELS");
export const OTP_OPTIONS = Symbol("OTP_OPTIONS");

export type OtpFetch = typeof fetch;

export interface OtpProviderRequestOptions {
	fetchImpl?: OtpFetch;
	timeoutMs?: number;
}
