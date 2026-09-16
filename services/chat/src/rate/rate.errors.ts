import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * 汇率模块错误（doc 05 异常兜底语义）。
 *
 * 任何情况下不得以 0、手填价或过期价充当有效报价：
 * - RATE_SOURCE_UNAVAILABLE（502）：数据源暂时不可用，可重试；响应体附库中最后一条报价时间（可为 null），
 *   供前端按 doc 05 展示「最后报价时间与原因」；
 * - RATE_PAIR_UNSUPPORTED（422）：数据源不提供该币对报价（如 frankfurter/ECB 无 TWD），重试无用。
 */
export class RateSourceUnavailableException extends HttpException {
	constructor(lastObservedAt: Date | string | null) {
		const iso =
			lastObservedAt instanceof Date
				? lastObservedAt.toISOString()
				: lastObservedAt;
		super(
			{
				code: "RATE_SOURCE_UNAVAILABLE",
				message: iso
					? `汇率数据源暂时不可用，最后有效报价时间为 ${iso}，请稍后重试`
					: "汇率数据源暂时不可用，请稍后重试",
				lastObservedAt: iso ?? null,
			},
			HttpStatus.BAD_GATEWAY,
		);
	}
}

export class RatePairUnsupportedException extends HttpException {
	constructor(base: string, target: string) {
		super(
			{
				code: "RATE_PAIR_UNSUPPORTED",
				message: `汇率数据源不支持 ${base} → ${target} 报价，无法提供该币种有效报价`,
			},
			HttpStatus.UNPROCESSABLE_ENTITY,
		);
	}
}
