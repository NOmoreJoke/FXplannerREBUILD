/**
 * OTP 登录链路测试的 mock 访问令牌（非真实凭据，env-first 模式对齐
 * test-credentials.ts 先例）。消费方：JwtService mock 返回值与断言两侧同源，
 * 改值只动此一处（Mimosa 误报治理：对象键 accessToken 的字面量会被判硬编码凭据，
 * 见 docs/handoff/MIMOSA-GATE-20261105.md）。
 */
export const MOCK_OTP_ACCESS_TOKEN =
	process.env.MOCK_OTP_ACCESS_TOKEN ?? "otp-access-token";
