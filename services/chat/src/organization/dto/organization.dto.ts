import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsNotEmpty, IsString, Matches, MaxLength } from "class-validator";

/** 组织创建/改名入参（ORG-01：名称 1~100 字符；先 trim 再校验，纯空白拒绝——评审 N-02） */
export class OrganizationUpsertDto {
	@ApiProperty({
		description: "组织名称（1~100 字符；首尾空白自动裁剪，纯空白拒绝）",
		example: "张三的工作台",
		type: String,
	})
	@Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
	@IsString()
	@IsNotEmpty()
	@Matches(/\S/, { message: "组织名称不能为空白" })
	@MaxLength(100)
	name!: string;
}

/** 组织列表项（GET /api/organizations：本人有效组织与建账状态） */
export class OrganizationViewDto {
	@ApiProperty({ description: "组织 id", type: String })
	id!: string;

	@ApiProperty({ description: "组织名称", type: String })
	name!: string;

	@ApiProperty({
		description: "当前用户在组织的角色",
		enum: ["OWNER", "ADMIN", "FINANCE", "OPERATOR", "VIEWER"],
		type: String,
	})
	role!: string;

	@ApiPropertyOptional({
		description: "组织本位币（未建账为 null）",
		type: String,
		nullable: true,
	})
	baseCurrency!: string | null;

	@ApiProperty({
		description: "是否已建账（OrganizationSettings 存在且记账起点已落）",
		type: Boolean,
	})
	onboardingCompleted!: boolean;

	@ApiProperty({ description: "创建时间（UTC ISO）", type: String, format: "date-time" })
	createdAt!: string;
}

/** 组织数据请求锁摘要（Goal #3B 拆分后的组织锁状态） */
export class OrganizationLockDto {
	@ApiProperty({ description: "是否存在进行中的组织数据请求锁", type: Boolean })
	active!: boolean;

	@ApiPropertyOptional({
		description: "锁类型（CLEAR/DELETION）",
		type: String,
		nullable: true,
	})
	type!: string | null;
}

/** 当前组织详情（GET /api/organizations/current：详情+角色+capabilities+锁+建账状态） */
export class OrganizationCurrentDto {
	@ApiProperty({ description: "组织 id", type: String })
	id!: string;

	@ApiProperty({ description: "组织名称", type: String })
	name!: string;

	@ApiProperty({
		description: "当前操作者角色",
		enum: ["OWNER", "ADMIN", "FINANCE", "OPERATOR", "VIEWER"],
		type: String,
	})
	role!: string;

	@ApiProperty({
		description: "capabilities 全量权限布尔表（后端真源）",
		type: "object",
		additionalProperties: { type: "boolean" },
	})
	capabilities!: Record<string, boolean>;

	@ApiProperty({ description: "是否已建账", type: Boolean })
	onboardingCompleted!: boolean;

	@ApiPropertyOptional({
		description: "组织本位币（未建账为 null）",
		type: String,
		nullable: true,
	})
	baseCurrency!: string | null;

	@ApiPropertyOptional({
		description: "记账起点（未建账为 null；UTC ISO）",
		type: String,
		nullable: true,
		format: "date-time",
	})
	ledgerStartedAt!: string | null;

	@ApiProperty({ description: "组织数据请求锁状态", type: OrganizationLockDto })
	dataRequestLock!: OrganizationLockDto;
}
