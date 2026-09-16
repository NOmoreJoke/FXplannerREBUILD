import { Module } from "@nestjs/common";
import { RateModule } from "../rate/rate.module";
import { HomeController } from "./home.controller";
import { HomeService } from "./home.service";

/**
 * 首页状态模块（home-state-routing）。
 * PrismaModule 为全局模块，无需重复导入；汇率域数据经 RateModule 出（home 不直接查 exchange_rates）。
 */
@Module({
	imports: [RateModule],
	controllers: [HomeController],
	providers: [HomeService],
})
export class HomeModule {}
