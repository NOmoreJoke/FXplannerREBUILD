import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { SendMessageDto } from "./services/chat/src/ai/dto/ai.dto";

const pipe = new ValidationPipe({ whitelist: true, transform: true });
const out = await pipe.transform(
	{ content: "你好" },
	{ type: "body", metatype: SendMessageDto },
);
console.log("REAL-DTO RESULT", JSON.stringify(out));
