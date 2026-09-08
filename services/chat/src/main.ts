import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { AppModule } from "./app.module";
// config/env.ts 在模块加载时完成两层 .env 文件加载 + zod 校验（fail-fast），
// 业务代码 import { env } 时 env 已就绪。
import { env, isDev } from "./config/env";
import { createSwaggerConfig } from "./config/swagger";

async function bootstrap() {
	const app = await NestFactory.create(AppModule);
	app.use(helmet());
	app.setGlobalPrefix("api");
	app.enableCors({ origin: env.CORS_ORIGIN, credentials: true });
	app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

	if (isDev()) {
		const document = SwaggerModule.createDocument(app, createSwaggerConfig());
		SwaggerModule.setup("docs", app, document, {
			useGlobalPrefix: true,
			jsonDocumentUrl: "docs-json",
			customSiteTitle: "FXPlanner API 文档",
		});
	}

	await app.listen(env.API_PORT);
	console.log(
		`[chat] mode=${env.NODE_ENV} port=${env.API_PORT} cors=${env.CORS_ORIGIN}`,
	);
}
bootstrap();
