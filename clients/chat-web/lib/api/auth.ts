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
	 * 发送 OTP 验证码（purpose 可选，默认 LOGIN；导出/清空/注销分别验证）
	 */
	async sendOtpCode(
		channel: OtpChannel,
		target: string,
		purpose?: "LOGIN" | "EXPORT" | "CLEAR" | "DELETION",
	): Promise<OtpChallengeResult> {
		return apiClient<OtpChallengeResult>("/auth/otp/send-code", {
			method: "POST",
			body: JSON.stringify({ channel, target, purpose }),
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
	 *
	 * 个人域端点（后端只挂 JwtAuthGuard）：与组织无关——请求不带组织头
	 * （skipOrganizationScope），换账号登录后首个请求不得携带上一个账号的组织。
	 */
	async getMe(): Promise<AuthUser> {
		return apiClient<AuthUser>("/auth/me", {
			method: "GET",
			skipOrganizationScope: true,
		});
	},

 /**
	 * 退出登录（客户端操作）：清除 token cookie
	 */
	logout() {
		clearToken();
	},
};
