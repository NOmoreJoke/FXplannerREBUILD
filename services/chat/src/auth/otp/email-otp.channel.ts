import {
	BadGatewayException,
	Injectable,
	Optional,
	ServiceUnavailableException,
} from "@nestjs/common";
import type { OtpChannel, OtpFetch } from "./otp-channel";

const DEFAULT_RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface EmailOtpChannelOptions {
	apiKey?: string;
	from?: string;
	endpoint?: string;
	fetchImpl?: OtpFetch;
	timeoutMs?: number;
}

@Injectable()
export class EmailOtpChannel implements OtpChannel {
	readonly channel = "email" as const;

	private readonly apiKey: string | undefined;
	private readonly from: string | undefined;
	private readonly endpoint: string;
	private readonly fetchImpl: OtpFetch;
	private readonly timeoutMs: number;

	constructor(@Optional() options?: EmailOtpChannelOptions) {
		this.apiKey = options?.apiKey ?? process.env.RESEND_API_KEY;
		this.from = options?.from ?? process.env.RESEND_FROM_EMAIL;
		this.endpoint =
			options?.endpoint ?? process.env.RESEND_API_URL ?? DEFAULT_RESEND_ENDPOINT;
		this.fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async send(target: string, code: string): Promise<void> {
		if (!this.apiKey || !this.from) {
			throw new ServiceUnavailableException(
				"Resend OTP 配置缺失：需要 RESEND_API_KEY 和 RESEND_FROM_EMAIL",
			);
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const response = await this.fetchImpl(this.endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					from: this.from,
					to: [target],
					subject: "Your verification code",
					text: `Your verification code is ${code}. It expires in 5 minutes.`,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new BadGatewayException(
					`Resend OTP 请求失败（HTTP ${response.status}）`,
				);
			}
		} catch (error) {
			if (
				error instanceof ServiceUnavailableException ||
				error instanceof BadGatewayException
			) {
				throw error;
			}
			if (controller.signal.aborted) {
				throw new ServiceUnavailableException("Resend OTP 请求超时");
			}
			throw new BadGatewayException("Resend OTP 服务不可用");
		} finally {
			clearTimeout(timeout);
		}
	}
}
