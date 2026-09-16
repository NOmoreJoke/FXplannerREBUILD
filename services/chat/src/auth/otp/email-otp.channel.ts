import {
	BadGatewayException,
	Injectable,
	Optional,
	ServiceUnavailableException,
} from "@nestjs/common";
import { isProd } from "../../config/env";
import type { OtpChannel, OtpFetch } from "./otp-channel";

const DEFAULT_RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface EmailOtpChannelOptions {
	apiKey?: string;
	from?: string;
	endpoint?: string;
	fetchImpl?: OtpFetch;
	timeoutMs?: number;
	/** 显式指定 mock 开关；未指定时按环境推导（见构造函数） */
	mock?: boolean;
}

@Injectable()
export class EmailOtpChannel implements OtpChannel {
	readonly channel = "email" as const;

	private readonly apiKey: string | undefined;
	private readonly from: string | undefined;
	private readonly endpoint: string;
	private readonly fetchImpl: OtpFetch;
	private readonly timeoutMs: number;

	/**
	 * 开发模拟模式（未接入真实邮件服务）：
	 * - 显式 OTP_EMAIL_MOCK=true 强制开启；OTP_EMAIL_MOCK=false 强制关闭；
	 * - 未显式配置时：非生产 && 未配置 Resend → 自动开启（本地开箱可用）；
	 * - 生产环境永不 mock：未配置供应商配置照旧抛 503。
	 */
	readonly devMode: boolean;

	constructor(@Optional() options?: EmailOtpChannelOptions) {
		this.apiKey = options?.apiKey ?? process.env.RESEND_API_KEY;
		this.from = options?.from ?? process.env.RESEND_FROM_EMAIL;
		this.endpoint =
			options?.endpoint ?? process.env.RESEND_API_URL ?? DEFAULT_RESEND_ENDPOINT;
		this.fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		if (options?.mock !== undefined) {
			this.devMode = options.mock;
		} else {
			const explicit = process.env.OTP_EMAIL_MOCK;
			const providerConfigured = Boolean(this.apiKey && this.from);
			this.devMode =
				explicit === "true" ||
				(explicit !== "false" && !providerConfigured && !isProd());
		}
	}

	async send(target: string, code: string): Promise<void> {
		if (this.devMode) {
			// mock：不真正发邮件，验证码打服务端日志；OtpService 会把 code 附在响应 devCode 里
			console.log(
				`[MOCK] EmailOtpChannel 模拟发送邮件 to=${target} code=${code}（10 分钟内有效；未接入真实邮件服务）`,
			);
			return;
		}

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
					text: `Your verification code is ${code}. It expires in 10 minutes.`,
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
