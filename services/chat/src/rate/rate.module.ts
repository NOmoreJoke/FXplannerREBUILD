import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { RateController } from "./rate.controller";
import {
	DEFAULT_RATE_PROVIDER_TIMEOUT_MS,
	RATE_PROVIDER_TIMEOUT_TOKEN,
	RateProvider,
} from "./rate.provider";
import { RateService } from "./rate.service";

@Module({
	imports: [PrismaModule],
	controllers: [RateController],
	providers: [
		RateService,
		RateProvider,
		{
			provide: RATE_PROVIDER_TIMEOUT_TOKEN,
			useValue: DEFAULT_RATE_PROVIDER_TIMEOUT_MS,
		},
	],
	exports: [RateService],
})
export class RateModule {}
