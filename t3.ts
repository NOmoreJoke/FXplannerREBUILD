import "reflect-metadata";
import { plainToInstance } from "class-transformer";
console.log("ct import ok");
const inst = plainToInstance(class T { content!: string }, { content: "x" });
console.log("ct transform ok", JSON.stringify(inst));
