import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { AuditModule } from "../audit/audit.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { OrganizationController } from "./organization.controller";
import { OrganizationService } from "./organization.service";
import { MemberController } from "./member.controller";
import { MemberService } from "./member.service";
import { InvitationController } from "./invitation.controller";
import { InvitationService } from "./invitation.service";

/**
 * 组织模块（技术方案 §4.1/§7.2；Goal #3A W17/W19）：
 * 组织、成员、邀请、组织切换视图与默认组织回填逻辑的唯一归属。
 * W17 组织 CRUD / W19 成员与邀请全生命周期。
 */
@Module({
	imports: [PrismaModule, AuthModule, AuditModule, AuthorizationModule],
	controllers: [OrganizationController, MemberController, InvitationController],
	providers: [OrganizationService, MemberService, InvitationService],
	exports: [OrganizationService],
})
export class OrganizationModule {}
