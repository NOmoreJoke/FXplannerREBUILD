import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Matches } from "class-validator";
import { SUPPORTED_CURRENCIES, VALID_PERIODS } from "../rate.constants";

const normalize = ({ value }: { value: unknown }) =>
	typeof value === "string" ? value.trim().toUpperCase() : value;

export class RateHistoryDto {
	@ApiPropertyOptional({
		description: "基准货币代码",
		enum: [...SUPPORTED_CURRENCIES],
		example: "USD",
		default: "USD",
	})
	@IsOptional()
	@IsString()
	@Matches(/^[A-Z]{3}$/)
	@IsIn([...SUPPORTED_CURRENCIES])
	@Transform(normalize)
	base = "USD";

	@ApiPropertyOptional({
		description: "目标货币代码",
		enum: [...SUPPORTED_CURRENCIES],
		example: "CNY",
		default: "CNY",
	})
	@IsOptional()
	@IsString()
	@Matches(/^[A-Z]{3}$/)
	@IsIn([...SUPPORTED_CURRENCIES])
	@Transform(normalize)
	target = "CNY";

	@ApiPropertyOptional({
		description: "查询天数",
		enum: [...VALID_PERIODS],
		example: 30,
		default: 30,
		type: Number,
	})
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@IsIn([...VALID_PERIODS])
	period = 30;
}
