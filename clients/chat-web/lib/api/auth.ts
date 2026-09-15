import { apiClient } from "@/lib/api/client";
import { clearToken } from "@/lib/auth/token";
import type {
	AuthResponse,
	AuthUser,
	OtpChannel,
	OtpChallengeResult,
	PasswordLoginInput,
	PasswordRegisterInput,
} from "@/lib/api/contract";

export const authApi = {
	/**
	 * 用户注册
	 */
	async register(dto: PasswordRegisterInput): Promise<AuthResponse> {
		const { email, password } = dto;
		return apiClient<AuthResponse>("/auth/register", {
			method: "POST",
			body: JSON.stringify({ email, password }),
			skipAuth: true,
		});
	},

	/**
	 * 密码登录
	 */
	async login(dto: PasswordLoginInput): Promise<AuthResponse> {
		return apiClient<AuthResponse>("/auth/login", {
			method: "POST",
			body: JSON.stringify(dto),
			skipAuth: true,
		});
	},

	/**
	 * 发送 OTP 登录验证码
	 */
	async sendOtpCode(
		channel: OtpChannel,
		target: string,
	): Promise<OtpChallengeResult> {
		return apiClient<OtpChallengeResult>("/auth/otp/send-code", {
			method: "POST",
			body: JSON.stringify({ channel, target }),
			skipAuth: true,
		});
	},

	/**
	 * 使用 OTP 登录
	 */
	async loginWithOtp(challengeId: string, code: string): Promise<AuthResponse> {
		return apiClient<AuthResponse>("/auth/otp/login", {
			method: "POST",
			body: JSON.stringify({ challengeId, code }),
			skipAuth: true,
		});
	},

	/**
	 * 获取当前用户信息
	 */
	async getMe(): Promise<AuthUser> {
		return apiClient<AuthUser>("/auth/me", {
			method: "GET",
		});
	},

 /**
	 * 退出登录（客户端操作）：清除 token cookie
	 */
	logout() {
		clearToken();
	},
};
