import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { CurrencyResponseDto } from "./dto/currency-response.dto";

/**
 * 币种字典服务：查询启用币种并做进程内缓存。
 *
 * 币种为静态字典（seed 从 @fxplanner-new/money 常量生成），
 * 缓存为模块级单例、进程生命周期内有效即可，无失效策略。
 */
@Injectable()
export class CurrencyService {
	/** 进程内缓存：首次查询后常驻 */
	private cache: CurrencyResponseDto[] | null = null;

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/** 查询启用中（isActive=true）的币种，按 sortOrder 升序 */
	async listActiveCurrencies(): Promise<CurrencyResponseDto[]> {
		if (this.cache) {
			return this.cache;
		}

		const rows = await this.prisma.currency.findMany({
			where: { isActive: true },
			orderBy: { sortOrder: "asc" },
		});

		const data: CurrencyResponseDto[] = rows.map((row) => ({
			code: row.code,
			nameZh: row.nameZh,
			nameEn: row.nameEn,
			decimalPlaces: row.decimalPlaces,
			sortOrder: row.sortOrder,
		}));
		this.cache = data;
		return data;
	}
}
