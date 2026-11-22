import {
	type ExecutionContext,
	Inject,
	Injectable,
	Optional,
	UnauthorizedException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import type { Request } from "express";
import { RequestAuthService } from "../request-auth.service";

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
	constructor(
		@Optional()
		@Inject(RequestAuthService)
		private readonly requestAuth?: RequestAuthService,
	) {
		super();
	}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		if (!this.requestAuth) {
			return (await super.canActivate(context)) as boolean;
		}
		const request = context.switchToHttp().getRequest<Request>();
		const resolved = await this.requestAuth.resolveBearerUser(request);
		if (resolved.status !== "authenticated") {
			throw new UnauthorizedException("Token 无效或已过期");
		}
		return true;
	}
}
