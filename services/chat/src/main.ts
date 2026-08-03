import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import helmet from "helmet";
import { AppModule } from "./app.module";
// config/env.ts 在模块加载时完成两层 .env 文件加载 + zod 校验（fail-fast），
// 业务代码 import { env } 时 env 已就绪。
import { env } from "./config/env";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.setGlobalPrefix("api");
  app.enableCors({ origin: env.CORS_ORIGIN, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(env.API_PORT);
  console.log(
    `[chat] mode=${env.NODE_ENV} port=${env.API_PORT} cors=${env.CORS_ORIGIN}`
  );
}
bootstrap();
