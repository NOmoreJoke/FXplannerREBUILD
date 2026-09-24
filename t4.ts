import "reflect-metadata";
import { IsString, IsOptional, MaxLength, Matches } from "class-validator";
import { ValidationPipe } from "@nestjs/common";

class SendMessageDto {
	@IsString() content!: string;
	@IsOptional()
	@IsString()
	@MaxLength(64)
	@Matches(/^[a-zA-Z0-9._-]+$/)
	modelKey?: string;
}

const pipe = new ValidationPipe({ whitelist: true, transform: true });
const out = await pipe.transform(
	{ content: "你好", modelKey: undefined },
	{ type: "body", metatype: SendMessageDto },
);
console.log("RESULT", JSON.stringify(out));
