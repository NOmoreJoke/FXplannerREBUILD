import { BadGatewayException } from "@nestjs/common";
import { invertQuoteRate } from "./rate-invert";

type RateTable = Record<string, unknown>;

export function parseRateResponse<T>(text: string) {
	// Keep metadata as ordinary JSON values. Index number tokens by the containing
	// object so multiple days with the same currency key keep their own source text.
	const numberTokens = new WeakMap<object, Map<string, string>>();
	const data = JSON.parse(text, function (
		this: object,
		key: string,
		value: unknown,
		context?: { source?: string },
	) {
		if (typeof value === "number" && context?.source !== undefined) {
			let tokens = numberTokens.get(this);
			if (!tokens) {
				tokens = new Map();
				numberTokens.set(this, tokens);
			}
			tokens.set(key, context.source);
		}
		return value;
	}) as T;

	return {
		data,
		readQuote(rates: RateTable | undefined, base: string, target: string) {
			const value = rates?.[target];
			if (value === undefined) return undefined;
			if (typeof value === "string") {
				return { raw: value, rate: invertQuoteRate(value, base, target) };
			}

			const numberToken = rates && numberTokens.get(rates)?.get(target);
			if (numberToken === undefined) {
				throw new BadGatewayException(`汇率源返回了无效牌价: ${base} → ${target}`);
			}
			return {
				raw: numberToken,
				rate: invertQuoteRate({ numberToken }, base, target),
			};
		},
	};
}
