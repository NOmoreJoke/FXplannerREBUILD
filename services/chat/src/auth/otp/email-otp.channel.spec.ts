import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

// mock nodemailer：工厂返回字面量，不引用外部变量（避免 hoisting 限制）
vi.mock("nodemailer", () => ({ createTransport: vi.fn() }));

import { createTransport } from "nodemailer";
import {
	EmailOtpChannel,
	isSmtpConfigured,
	type EmailOtpChannelOptions,
} from "./email-otp.channel";
import {
	BadGatewayException,
	ServiceUnavailableException,
} from "@nestjs/common";
import { VERIFY_CODE_SUBJECT } from "./email-otp.templates";

const fullOptions: EmailOtpChannelOptions = {
	host: "smtpdm.aliyun.com",
	port: 465,
	user: "noreply@fxplanner.example.com",
	pass: "secret-smtp-pass",
};

/** 安装 Transport mock 并返回其 sendMail 的 mock 引用 */
function installTransportMock() {
	const sendMail = vi.fn().mockResolvedValue({ messageId: "mock-message-id" });
	vi.mocked(createTransport).mockReturnValue({ sendMail } as never);
	return sendMail;
}

beforeEach(() => {
	vi.clearAllMocks();
	installTransportMock();
	// 隔离 env 推导：清掉可能存在的供应商/mock 配置（vitest 环境本就未设置，防御性再删一次）
	delete process.env.OTP_EMAIL_MOCK;
	delete process.env.SMTP_USER;
	delete process.env.SMTP_PASS;
});

afterEach(() => {
	delete process.env.OTP_EMAIL_MOCK;
	delete process.env.SMTP_USER;
	delete process.env.SMTP_PASS;
});

describe("isSmtpConfigured", () => {
	it("HOST / USER / PASS 同时存在 → true", () => {
		expect(isSmtpConfigured(fullOptions)).toBe(true);
	});

	it("缺少 PASS → false", () => {
		expect(isSmtpConfigured({ ...fullOptions, pass: "" })).toBe(false);
	});

	it("缺少 USER → false", () => {
		expect(isSmtpConfigured({ ...fullOptions, user: "" })).toBe(false);
	});
});

describe("构造与 transport 创建", () => {
	it("已配置 → 创建 Transport，参数指向阿里云邮件推送 SMTP（465 SSL）", () => {
		new EmailOtpChannel(fullOptions);
		expect(createTransport).toHaveBeenCalledTimes(1);
		expect(createTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				host: "smtpdm.aliyun.com",
				port: 465,
				secure: true,
				auth: {
					user: "noreply@fxplanner.example.com",
					pass: "secret-smtp-pass",
				},
			}),
		);
	});

	it("端口非 465 → secure=false（STARTTLS 由 nodemailer 协商）", () => {
		new EmailOtpChannel({ ...fullOptions, port: 80 });
		expect(createTransport).toHaveBeenCalledWith(
			expect.objectContaining({ port: 80, secure: false }),
		);
	});

	it("user/pass 未配置 → 不创建 Transport", () => {
		new EmailOtpChannel({ host: "smtpdm.aliyun.com" });
		expect(createTransport).not.toHaveBeenCalled();
	});

	it("显式注入 transport → 不再经 createTransport 创建", () => {
		const transport = { sendMail: vi.fn() } as never;
		new EmailOtpChannel({ transport });
		expect(createTransport).not.toHaveBeenCalled();
	});
});

describe("send", () => {
	it("已配置 → 发送邮件：收件人/主题/发件人正确，正文含验证码", async () => {
		const sendMail = installTransportMock();
		const channel = new EmailOtpChannel(fullOptions);
		expect(channel.devMode).toBe(false);

		await channel.send("user@example.com", "654321");

		expect(sendMail).toHaveBeenCalledTimes(1);
		expect(sendMail).toHaveBeenCalledWith(
			expect.objectContaining({
				// 阿里云邮件推送要求发件地址与 SMTP_USER 一致
				from: {
					name: "FXPlanner",
					address: "noreply@fxplanner.example.com",
				},
				to: "user@example.com",
				subject: VERIFY_CODE_SUBJECT,
			}),
		);
		const html: string = sendMail.mock.calls[0][0].html;
		expect(html).toContain("654321");
		expect(html).toContain("10 分钟");
	});

	it("发送失败 → 向上抛 502（由 OtpService 删除 challenge 回滚）", async () => {
		const sendMail = installTransportMock();
		sendMail.mockRejectedValueOnce(new Error("535 Authentication failed"));
		const channel = new EmailOtpChannel(fullOptions);
		await expect(
			channel.send("user@example.com", "123456"),
		).rejects.toBeInstanceOf(BadGatewayException);
	});

	it("SMTP 超时 → 抛 503（ServiceUnavailable）", async () => {
		const sendMail = installTransportMock();
		sendMail.mockRejectedValueOnce(new Error("Connection timeout"));
		const channel = new EmailOtpChannel(fullOptions);
		await expect(
			channel.send("user@example.com", "123456"),
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it("显式注入 transport → 用注入的 transport 发送", async () => {
		const sendMail = vi.fn().mockResolvedValue({ messageId: "x" });
		const channel = new EmailOtpChannel({
			user: "noreply@fxplanner.example.com",
			pass: "secret-smtp-pass",
			transport: { sendMail } as never,
		});
		await channel.send("user@example.com", "111222");
		expect(sendMail).toHaveBeenCalledTimes(1);
	});
});

describe("devMode 推导", () => {
	it("显式 mock:true → 强制 mock（即使已配置供应商）", () => {
		const channel = new EmailOtpChannel({ ...fullOptions, mock: true });
		expect(channel.devMode).toBe(true);
	});

	it("显式 mock:false → 强制真实（即使未配置）", () => {
		const channel = new EmailOtpChannel({ mock: false });
		expect(channel.devMode).toBe(false);
	});

	it("未显式 + 未配置 SMTP + 非生产 → 自动 mock（本地开箱可用）", () => {
		const channel = new EmailOtpChannel({ host: "smtpdm.aliyun.com" });
		expect(channel.devMode).toBe(true);
	});

	it("未显式 + 已配置 SMTP → 真实渠道", () => {
		const channel = new EmailOtpChannel(fullOptions);
		expect(channel.devMode).toBe(false);
	});

	it("OTP_EMAIL_MOCK=true 覆盖已配置供应商 → 强制 mock", () => {
		process.env.OTP_EMAIL_MOCK = "true";
		const channel = new EmailOtpChannel(fullOptions);
		expect(channel.devMode).toBe(true);
	});

	it("OTP_EMAIL_MOCK=false 覆盖自动推导 → 真实渠道", () => {
		process.env.OTP_EMAIL_MOCK = "false";
		const channel = new EmailOtpChannel({ host: "smtpdm.aliyun.com" });
		expect(channel.devMode).toBe(false);
	});

	it("注入 transport 视为已配置 → devMode=false", () => {
		const channel = new EmailOtpChannel({
			transport: { sendMail: vi.fn() } as never,
		});
		expect(channel.devMode).toBe(false);
	});
});

describe("mock 模式与未配置的 send 行为", () => {
	it("mock 渠道 send 不经网络、不抛错", async () => {
		const sendMail = installTransportMock();
		const channel = new EmailOtpChannel({ ...fullOptions, mock: true });
		await expect(channel.send("a@b.com", "123456")).resolves.toBeUndefined();
		expect(sendMail).not.toHaveBeenCalled();
	});

	it("显式 mock:false 且未配置 → send 抛 503（生产永不 mock 的兜底）", async () => {
		const channel = new EmailOtpChannel({ mock: false });
		await expect(channel.send("a@b.com", "123456")).rejects.toBeInstanceOf(
			ServiceUnavailableException,
		);
	});
});
