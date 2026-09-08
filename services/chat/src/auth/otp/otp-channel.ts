import type { OtpChannelType } from "./dto/send-otp-code.dto";

export type { OtpChannelType } from "./dto/send-otp-code.dto";

export interface OtpChannel {
	readonly channel: OtpChannelType;
	send(target: string, code: string): Promise<void>;
}

export const OTP_CHANNELS = Symbol("OTP_CHANNELS");
export const OTP_OPTIONS = Symbol("OTP_OPTIONS");

export type OtpFetch = typeof fetch;

export interface OtpProviderRequestOptions {
	fetchImpl?: OtpFetch;
	timeoutMs?: number;
}
