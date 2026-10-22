/**
 * E2E 测试夹具密码（非真实凭据）。
 *
 * 注册/登录接口要求密码 ≥8 位且包含字母与数字；默认值仅为本地与 CI
 * 自动化测试使用，可用环境变量 E2E_TEST_PASSWORD / E2E_ALT_PASSWORD 覆盖。
 */
export const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD ?? "E2ePassw0rd";

/** 第二个测试密码（邮箱已存在 / 密码不符等反例场景） */
export const TEST_ALT_PASSWORD = process.env.E2E_ALT_PASSWORD ?? "E2eAltPassw0rd";
