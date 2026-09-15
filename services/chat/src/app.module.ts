import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { AppController } from "./app.controller";
import { PrismaModule } from "./prisma/prisma.module";
import { RateModule } from "./rate/rate.module";
import { CurrencyModule } from "./currency/currency.module";
import { AuthModule } from "./auth/auth.module";
import { AccountModule } from "./account/account.module";

@Module({
	imports: [
		ThrottlerModule.forRoot([
			{
				ttl: 60000,
				limit: 10,
			},
		]),
		PrismaModule,
		AuthModule,
		RateModule,
		CurrencyModule,
		AccountModule,
	],
	controllers: [AppController],
	providers: [
		{
			provide: APP_GUARD,
			useClass: ThrottlerGuard,
		},
	],
})
export class AppModule {}
