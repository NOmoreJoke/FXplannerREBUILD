import { DocumentBuilder } from "@nestjs/swagger";

export function createSwaggerConfig() {
	return new DocumentBuilder()
		.setTitle("FXPlanner Chat API")
		.setDescription("FXPlanner 后端接口文档")
		.setVersion("1.0")
		.addTag("System", "服务存活检查")
		.addTag("Auth", "密码与 OTP 独立账号认证")
		.addTag("Rate", "支持币种、最新汇率和历史汇率查询")
		.addBearerAuth()
		.build();
}
