import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { VALID_PERIODS } from "../rate.constants";

/**
 * history 响应 DTO（MVP-F0-2 C2）：RateService.getHistory 返回的 data 部分。
 * 此前该端点响应无 OpenAPI schema（前端手写影子类型，DEBT-05/W11 清零范围）；
 * 逐点 source 标注落地时补齐契约（来源标注由后端 DTO 定义并重生成前端类型）。
 */
export class RateHistoryPointDto {
	@ApiProperty({
		description: "观测日（YYYY-MM-DD，UTC）",
		example: "2026-09-15",
		type: String,
	})
	date!: string;

	@ApiProperty({
		description: "汇率（1 外币 = X 本位币；数据源原始精度字符串）",
		example: "0.2102297812",
		type: String,
	})
	rate!: string;

	@ApiPropertyOptional({
		description:
			"逐点来源：本地行 = 落库数据源（abc / er-api / frankfurter / identity）；" +
			"参考补点 = frankfurter-v2-reference（参考价，非原来源报价，图表须区分展示）",
		example: "er-api",
		type: String,
	})
	source?: string;
}

export class RateHistoryResponseDto {
	@ApiProperty({ description: "基准币种代码", example: "USD", type: String })
	base!: string;

	@ApiProperty({ description: "目标币种代码", example: "TWD", type: String })
	target!: string;

	@ApiProperty({
		description: "查询天数",
		enum: [...VALID_PERIODS],
		example: 7,
		type: Number,
	})
	period!: number;

	@ApiProperty({
		description: "历史序列（工作日；TWD 冷缺口由 v2 参考序列补点并标注来源）",
		type: [RateHistoryPointDto],
	})
	data_points!: RateHistoryPointDto[];

	@ApiProperty({
		description: "序列末点汇率；空序列为 null",
		nullable: true,
		type: String,
		example: "0.2102297812",
	})
	current_rate!: string | null;
}
