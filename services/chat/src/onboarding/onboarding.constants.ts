/**
 * 首次设置模块常量（技术方案 §2/§3，schema 冻结：不新增任何模型与字段）。
 */

/** 当前生效的服务条款版本（本期唯一版本，无新版条款流程；技术方案 §3.3） */
export const CURRENT_TERMS_VERSION = "2026-01";

/** 必要条款确认类型：已满 18 周岁 + 同意当前版本服务条款（doc 01 条款先行） */
export const CONSENT_TYPES = ["age18", "terms"] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];
