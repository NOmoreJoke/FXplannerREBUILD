import { Controller, Get, Header, Inject } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CurrencyService } from "./currency.service";
import { CurrencyListResponseDto } from "./dto/currency-response.dto";

/**
 * 币种字典接口。全局前缀 /api 由 main.ts 提供，控制器内不重复；
 * 公开路由：清单非敏感，且首次设置需在选定本位币前使用。
 */
@ApiTags("Currency")
@Controller("currencies")
export class CurrencyController {
	constructor(
		@Inject(CurrencyService) private readonly currencyService: CurrencyService,
	) {}

	@Get()
	@ApiOperation({
		summary: "查询支持的币种清单",
		description:
			"返回全部启用中的币种（isActive=true），按 sortOrder 升序。静态字典，客户端可缓存 1 小时。",
	})
	@ApiResponse({
		status: 200,
		description: "响应体为 { success, data: CurrencyListResponseDto } 包装。",
		type: CurrencyListResponseDto,
	})
	@Header("Cache-Control", "public, max-age=3600")
	async list(): Promise<CurrencyListResponseDto> {
		const items = await this.currencyService.listActiveCurrencies();
		return { items };
	}
}
