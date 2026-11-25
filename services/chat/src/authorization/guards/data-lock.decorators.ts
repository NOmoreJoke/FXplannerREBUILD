import { SetMetadata } from "@nestjs/common";

/**
 * 双锁白名单装饰器（技术方案 §9.3；Goal #3B W27）。
 *
 * 两个白名单装饰器都在授权层（横切能力，audit 等模块亦须挂载锁守卫，
 * 但禁止引入业务记账模块），数据请求模块统一从此处引入。
 *
 * 语义：标注的端点跳过**对应的那一把锁**的判定，但**仍然推进到期请求**
 * （读时惰性推进与白名单无关）；库查询异常时白名单端点仅 log warn 放行，
 * 非白名单端点 fail-closed 抛 500。
 */

/** 个人账号锁白名单（本人注销处理中仍可查看进度 / 撤回 / 下载 / 发验证码） */
export const SKIP_PERSONAL_ACCOUNT_LOCK_KEY = "skipPersonalAccountLock";
export const SkipPersonalAccountLock = () =>
	SetMetadata(SKIP_PERSONAL_ACCOUNT_LOCK_KEY, true);

/** 组织数据锁白名单（组织清空 / 删除处理中仍可拉锁摘要 / 撤回 / 下载） */
export const SKIP_ORGANIZATION_LOCK_KEY = "skipOrganizationLock";
export const SkipOrganizationLock = () =>
	SetMetadata(SKIP_ORGANIZATION_LOCK_KEY, true);
