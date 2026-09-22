import {
	BadGatewayException,
	Injectable,
	Optional,
	ServiceUnavailableException,
} from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import { isProd } from "../../config/env";
import type { OtpChannel } from "./otp-channel";
import { renderVerifyCodeHtml, VERIFY_CODE_SUBJECT } from "./email-otp.templates";

const DEFAULT_SMTP_HOST = "smtpdm.aliyun.com"; // 阿里云邮件推送 DirectMail SMTP
const DEFAULT_SMTP_PORT = 465; // SSL
const DEFAULT_FROM_NAME = "FXPlanner";

export interface EmailOtpChannelOptions {
	host?: string;
	port?: number;
	/** 发信地址（阿里云邮件推送控制台创建，如 noreply@example.com） */
	user?: string;
	pass?: string;
	/** 发件人显示名 */
	fromName?: string;
	/** 直接注入 transporter（单测用）；注入后视为「已配置真实供应商」 */
	transport?: Transporter;
	/** 显式指定 mock 开关；未指定时按环境推导（见构造函数） */
	mock?: boolean;
}

/** SMTP 三要素（HOST/USER/PASS）是否齐备 */
export function isSmtpConfigured(options: {
	host?: string;
	user?: string;
	pass?: string;
}): boolean {
	return Boolean(options.host && options.user && options.pass);
}

@Injectable()
export class EmailOtpChannel implements OtpChannel {
	readonly channel = "email" as const;

	private readonly host: string | undefined;
	private readonly port: number;
	private readonly user: string | undefined;
	private readonly pass: string | undefined;
	private readonly fromName: string;
	private readonly transport: Transporter | undefined;

	/**
	 * 开发模拟模式（未接入真实邮件服务）：
	 * - 显式 OTP_EMAIL_MOCK=true 强制开启；OTP_EMAIL_MOCK=false 强制关闭；
	 * - 未显式配置时：非生产 && 未配置 SMTP → 自动开启（本地开箱可用）；
	 * - 生产环境永不 mock：未配置供应商配置照旧抛 503。
	 */
	readonly devMode: boolean;

	constructor(@Optional() options?: EmailOtpChannelOptions) {
		this.host = options?.host ?? process.env.SMTP_HOST ?? DEFAULT_SMTP_HOST;
		this.port =
			options?.port ??
			(process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : DEFAULT_SMTP_PORT);
		this.user = options?.user ?? process.env.SMTP_USER;
		this.pass = options?.pass ?? process.env.SMTP_PASS;
		this.fromName =
			options?.fromName ?? process.env.SMTP_FROM_NAME ?? DEFAULT_FROM_NAME;
		this.transport = options?.transport;

		if (options?.mock !== undefined) {
			this.devMode = options.mock;
		} else {
			const explicit = process.env.OTP_EMAIL_MOCK;
			const providerConfigured =
				Boolean(this.transport) ||
				isSmtpConfigured({ host: this.host, user: this.user, pass: this.pass });
			this.devMode =
				explicit === "true" ||
				(explicit !== "false" && !providerConfigured && !isProd());
		}

		if (!this.transport && this.host && this.user && this.pass) {
			this.transport = createTransport({
				host: this.host,
				port: this.port,
				secure: this.port === 465, // 465 SSL；其他端口走 STARTTLS（由 nodemailer 自动协商）
				auth: { user: this.user, pass: this.pass },
				connectionTimeout: 8_000,
				greetingTimeout: 8_000,
				socketTimeout: 15_000,
			});
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

		if (!this.transport || !isSmtpConfigured({ host: this.host, user: this.user, pass: this.pass })) {
			throw new ServiceUnavailableException(
				"阿里云邮件推送 OTP 配置缺失：需要 SMTP_HOST、SMTP_USER 和 SMTP_PASS",
			);
		}

		try {
			await this.transport.sendMail({
				// 阿里云邮件推送要求：发件地址必须与 SMTP_USER 一致
				from: { name: this.fromName, address: this.user },
				to: target,
				subject: VERIFY_CODE_SUBJECT,
				html: renderVerifyCodeHtml(code),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/timeout|ETIMEDOUT|ESOCKET|greeting/i.test(message)) {
				throw new ServiceUnavailableException("阿里云邮件推送 SMTP 请求超时");
			}
			throw new BadGatewayException(`阿里云邮件推送 SMTP 发送失败：${message}`);
		}
	}
}
