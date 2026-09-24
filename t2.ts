import "reflect-metadata";
import { IsString } from "class-validator";
class T { @IsString() content!: string; }
console.log("cv ok");
