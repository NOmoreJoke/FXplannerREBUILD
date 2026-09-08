import { ApiProperty } from "@nestjs/swagger";

/**
 * 币种出参 DTO：OpenAPI 契约来源，前端类型由生成管线产出，注解必须完整。
 */
export class CurrencyResponseDto {
	@ApiProperty({
		description: "ISO 4217 币种代码（3 位大写）",
		example: "HKD",
		type: String,
	})
	code!: string;

	@ApiProperty({
		description: "币种中文名",
		example: "港币",
		type: String,
	})
	nameZh!: string;

	@ApiProperty({
		description: "币种英文名",
		example: "Hong Kong Dollar",
		type: String,
	})
	nameEn!: string;

	@ApiProperty({
		description: "金额小数位（0=整数币种如 JPY/KRW，2=两位小数）",
		example: 2,
		enum: [0, 2],
		type: Number,
	})
	decimalPlaces!: number;

	@ApiProperty({
		description: "展示顺序，从 1 起严格递增",
		example: 1,
		type: Number,
	})
	sortOrder!: number;
}

/** GET /api/currencies 出参 */
export class CurrencyListResponseDto {
	@ApiProperty({
		description: "启用中的币种清单（isActive=true），按 sortOrder 升序",
		type: [CurrencyResponseDto],
	})
	items!: CurrencyResponseDto[];
}
