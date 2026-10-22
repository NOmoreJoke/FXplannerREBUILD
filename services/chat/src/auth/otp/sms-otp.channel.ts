import {
	BadGatewayException,
	Injectable,
	Optional,
	ServiceUnavailableException,
} from "@nestjs/common";
import { createHmac, randomUUID } from "node:crypto";
import type { OtpChannel, OtpFetch } from "./otp-channel";

const DEFAULT_ALIYUN_ENDPOINT = "https://dysmsapi.aliyuncs.com/";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface SmsOtpChannelOptions {
	accessKeyId?: string;
	accessKeySecret?: string;
	signName?: string;
	templateCode?: string;
	endpoint?: string;
	fetchImpl?: OtpFetch;
	timeoutMs?: number;
}

function encode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function sign(secret: string, parameters: Record<string, string>): string {
	const canonicalized = Object.keys(parameters)
		.sort()
		.map((key) => `${encode(key)}=${encode(parameters[key])}`)
		.join("&");
	const stringToSign = `GET&%2F&${encode(canonicalized)}`;
	// 阿里云 RPC 签名 V1.0 支持 HMAC-SHA256（流程与 SHA1 一致，仅哈希不同）；
	// SHA1 已被安全扫描列为弱算法，这里统一使用 SHA256。
	return createHmac("sha256", `${secret}&`).update(stringToSign).digest("base64");
}

@Injectable()
export class SmsOtpChannel implements OtpChannel {
	readonly channel = "phone" as const;

	private readonly accessKeyId: string | undefined;
	private readonly accessKeySecret: string | undefined;
	private readonly signName: string | undefined;
	private readonly templateCode: string | undefined;
	private readonly endpoint: string;
	private readonly fetchImpl: OtpFetch;
	private readonly timeoutMs: number;

	constructor(@Optional() options?: SmsOtpChannelOptions) {
		this.accessKeyId = options?.accessKeyId ?? process.env.ALIYUN_ACCESS_KEY_ID;
		this.accessKeySecret =
			options?.accessKeySecret ?? process.env.ALIYUN_ACCESS_KEY_SECRET;
		this.signName = options?.signName ?? process.env.ALIYUN_SMS_SIGN_NAME;
		this.templateCode =
			options?.templateCode ?? process.env.ALIYUN_SMS_TEMPLATE_CODE;
		this.endpoint =
			options?.endpoint ??
			process.env.ALIYUN_SMS_ENDPOINT ??
			DEFAULT_ALIYUN_ENDPOINT;
		this.fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async send(target: string, code: string): Promise<void> {
		if (
			!this.accessKeyId ||
			!this.accessKeySecret ||
			!this.signName ||
			!this.templateCode
		) {
			throw new ServiceUnavailableException(
				"阿里云短信 OTP 配置缺失：需要 ALIYUN_ACCESS_KEY_ID、ALIYUN_ACCESS_KEY_SECRET、ALIYUN_SMS_SIGN_NAME 和 ALIYUN_SMS_TEMPLATE_CODE",
			);
		}

		const parameters: Record<string, string> = {
			AccessKeyId: this.accessKeyId,
			Action: "SendSms",
			Format: "JSON",
			PhoneNumbers: target,
			RegionId: "cn-hangzhou",
			SignatureMethod: "HMAC-SHA256",
			SignatureNonce: randomUUID(),
			SignatureVersion: "1.0",
			SignName: this.signName,
			TemplateCode: this.templateCode,
			TemplateParam: JSON.stringify({ code }),
			Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
			Version: "2017-05-25",
		};
		const signature = sign(this.accessKeySecret, parameters);
		const query = new URLSearchParams({ ...parameters, Signature: signature });
		const url = `${this.endpoint}${this.endpoint.includes("?") ? "&" : "?"}${query.toString()}`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const response = await this.fetchImpl(url, {
				method: "GET",
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new BadGatewayException(
					`阿里云短信 OTP 请求失败（HTTP ${response.status}）`,
				);
			}

			let body: unknown;
			try {
				body = await response.json();
			} catch {
				throw new BadGatewayException("阿里云短信 OTP 返回了无效响应");
			}
			if (
				!body ||
				typeof body !== "object" ||
				(body as { Code?: unknown }).Code !== "OK"
			) {
				throw new BadGatewayException("阿里云短信 OTP 发送失败");
			}
		} catch (error) {
			if (
				error instanceof ServiceUnavailableException ||
				error instanceof BadGatewayException
			) {
				throw error;
			}
			if (controller.signal.aborted) {
				throw new ServiceUnavailableException("阿里云短信 OTP 请求超时");
			}
			throw new BadGatewayException("阿里云短信 OTP 服务不可用");
		} finally {
			clearTimeout(timeout);
		}
	}
}
