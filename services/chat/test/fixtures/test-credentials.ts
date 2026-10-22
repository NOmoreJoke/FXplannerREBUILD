/**
 * 单元/接口测试夹具密码（非真实凭据）。
 *
 * 注册接口要求密码 ≥8 位且包含字母与数字；默认值仅为本地与 CI
 * 自动化测试使用，可用环境变量 TEST_PASSWORD / TEST_ALT_PASSWORD 覆盖。
 */
export const TEST_PASSWORD = process.env.TEST_PASSWORD ?? "UnitPassw0rd";

/** 第二个测试密码（密码错误等反例场景，不用于成功登录） */
export const TEST_ALT_PASSWORD = process.env.TEST_ALT_PASSWORD ?? "WrongPassw0rd";
