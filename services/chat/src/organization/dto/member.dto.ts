import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
	IsEmail,
	IsIn,
	IsNotEmpty,
	IsString,
	MaxLength,
} from "class-validator";
import { INVITABLE_ROLES } from "../invitation-rules";

/** 可分配角色（OWNER 禁止出现在调整/邀请入参——DTO 白名单第一道闸） */
const ASSIGNABLE_ROLES = ["ADMIN", "FINANCE", "OPERATOR", "VIEWER"] as const;

/** 响应侧全角色（成员列表/视图必然包含 OWNER 行） */
const ALL_ROLES = ["OWNER", "ADMIN", "FINANCE", "OPERATOR", "VIEWER"] as const;

/** 邀请状态归并（展示态） */
const INVITATION_STATUSES = [
	"OPEN",
	"ACCEPTED",
	"DECLINED",
	"REVOKED",
	"EXPIRED",
] as const;

/** 成员列表项（GET /organizations/current/members） */
export class MemberViewDto {
	@ApiProperty({ description: "Membership id", type: String })
	id!: string;

	@ApiProperty({ description: "用户 id", type: String })
	userId!: string;

	@ApiPropertyOptional({
		description: "显示名（无则为 null）",
		type: String,
		nullable: true,
	})
	name!: string | null;

	@ApiPropertyOptional({
		description: "邮箱（无邮箱账号为 null）",
		type: String,
		nullable: true,
	})
	email!: string | null;

	@ApiProperty({ description: "角色", enum: ALL_ROLES, type: String })
	role!: string;

	@ApiProperty({
		description: "状态",
		enum: ["ACTIVE", "DISABLED"],
		type: String,
	})
	status!: string;

	@ApiProperty({
		description: "加入时间（UTC ISO）",
		type: String,
		format: "date-time",
	})
	joinedAt!: string;
}

/** 角色调整入参（PATCH /organizations/current/members/:id） */
export class UpdateMemberDto {
	@ApiProperty({
		description: "新角色（禁止调整为 OWNER——所有权只走转移）",
		enum: ASSIGNABLE_ROLES,
		type: String,
	})
	@IsIn(ASSIGNABLE_ROLES)
	role!: string;
}

/** 创建邀请入参（POST /organizations/current/invitations） */
export class CreateInvitationDto {
	@ApiProperty({ description: "受邀邮箱", example: "finance@example.com", type: String })
	@IsEmail()
	@IsNotEmpty()
	@MaxLength(254)
	email!: string;

	@ApiProperty({
		description: "受邀角色（禁止 OWNER）",
		enum: INVITABLE_ROLES,
		type: String,
	})
	@IsIn(INVITABLE_ROLES)
	role!: string;
}

/** 邀请创建响应（原始 token 仅本次出现；tokenHash 绝不返回） */
export class InvitationCreatedDto {
	@ApiProperty({ description: "邀请 id", type: String })
	id!: string;

	@ApiProperty({ description: "规范化邮箱", type: String })
	email!: string;

	@ApiProperty({ description: "角色", enum: INVITABLE_ROLES, type: String })
	role!: string;

	@ApiProperty({
		description: "过期时间（UTC ISO）",
		type: String,
		format: "date-time",
	})
	expiresAt!: string;

	@ApiProperty({
		description:
			"邀请 token（仅本次响应出现；服务端只存 SHA-256 hash；幂等复用时为空串）",
		type: String,
	})
	token!: string;

	@ApiProperty({ description: "是否幂等复用了既有有效邀请", type: Boolean })
	reused!: boolean;
}

/** 邀请列表项（GET /organizations/current/invitations；无 token/tokenHash） */
export class InvitationViewDto {
	@ApiProperty({ description: "邀请 id", type: String })
	id!: string;

	@ApiProperty({ description: "受邀邮箱（规范化）", type: String })
	email!: string;

	@ApiProperty({ description: "角色", enum: INVITABLE_ROLES, type: String })
	role!: string;

	@ApiPropertyOptional({
		description: "邀请人显示名",
		type: String,
		nullable: true,
	})
	invitedByName!: string | null;

	@ApiProperty({
		description: "过期时间（UTC ISO）",
		type: String,
		format: "date-time",
	})
	expiresAt!: string;

	@ApiProperty({
		description: "状态",
		enum: INVITATION_STATUSES,
		type: String,
	})
	status!: string;

	@ApiPropertyOptional({
		description: "接受时间（未接受 null；UTC ISO）",
		type: String,
		nullable: true,
		format: "date-time",
	})
	acceptedAt!: string | null;
}

/** 受邀摘要（GET /organization-invitations/:token；脱敏：无业务数据/无 tokenHash） */
export class InvitationSummaryDto {
	@ApiProperty({ description: "组织 id", type: String })
	organizationId!: string;

	@ApiProperty({ description: "组织名称", type: String })
	organizationName!: string;

	@ApiProperty({ description: "受邀邮箱（规范化）", type: String })
	email!: string;

	@ApiProperty({ description: "角色", enum: INVITABLE_ROLES, type: String })
	role!: string;

	@ApiPropertyOptional({
		description: "邀请人显示名",
		type: String,
		nullable: true,
	})
	invitedByName!: string | null;

	@ApiProperty({
		description: "过期时间（UTC ISO）",
		type: String,
		format: "date-time",
	})
	expiresAt!: string;

	@ApiProperty({
		description: "状态",
		enum: INVITATION_STATUSES,
		type: String,
	})
	status!: string;
}

/** 所有权转移入参（POST /organizations/current/transfer-ownership） */
export class TransferOwnershipDto {
	@ApiProperty({ description: "接任成员的 Membership id", type: String })
	@IsString()
	@IsNotEmpty()
	targetMembershipId!: string;
}
