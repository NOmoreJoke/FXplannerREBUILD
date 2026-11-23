import {
	createParamDecorator,
	type ExecutionContext,
} from "@nestjs/common";
import type { ActorContext } from "../authorization.types";

/**
 * 当前操作者参数装饰器（技术方案 §4.2；Goal #3A W17）：
 * 读取 OrganizationContextGuard 构造并挂载在 request.actor 上的 ActorContext。
 * 仅可在挂载了 OrganizationContextGuard 的路由使用（否则 actor 为 undefined）。
 */
export const CurrentActor = createParamDecorator(
	(_: unknown, ctx: ExecutionContext): ActorContext =>
		ctx.switchToHttp().getRequest().actor as ActorContext,
);
