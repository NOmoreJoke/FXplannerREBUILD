/**
 * money 包错误体系：所有精度/校验错误都以类型化 Error 抛出，
 * 调用方（前端提示、后端拦截）按 code 或类型分支处理。
 */

/** money 包错误基类 */
export class MoneyError extends Error {
	/** 机器可读错误码，供调用方做分支处理与文案映射 */
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = new.target.name;
		this.code = code;
	}
}

/** 正数金额按币种精度舍入后为 0（不得入账，必须拦截提示） */
export class RoundToZeroError extends MoneyError {
	constructor(message = "金额舍入后为 0，已拦截，不予入账") {
		super("MONEY_ROUND_TO_ZERO", message);
	}
}

/** 金额达到或超过单笔上限 100,000,000,000（超限提示修改，不截断保存） */
export class AmountLimitExceededError extends MoneyError {
	constructor(message = "金额超出单笔上限 100,000,000,000，请修改后重试") {
		super("MONEY_AMOUNT_LIMIT_EXCEEDED", message);
	}
}

/** 金额不是大于 0 的有效数字 */
export class InvalidAmountError extends MoneyError {
	constructor(message = "金额必须为大于 0 的有效数字") {
		super("MONEY_INVALID_AMOUNT", message);
	}
}

/** 汇率不是大于 0 的有效数字 */
export class InvalidRateError extends MoneyError {
	constructor(message = "汇率必须为大于 0 的有效数字") {
		super("MONEY_INVALID_RATE", message);
	}
}
