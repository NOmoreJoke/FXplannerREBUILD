import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
	IsIn,
	IsInt,
	IsISO8601,
	IsOptional,
	IsString,
	Max,
	Min,
} from "class-validator";

/** 审计动作结果三态（AUDIT-02；与 AuditLog.result 列同源） */
export const AUDIT_RESULTS = ["SUCCESS", "DENIED", "FAILED"] as const;

/** 审计日志只读视图（AUDIT-03：无编辑/删除入口；detail 已脱敏） */
export class AuditLogViewDto {
	@ApiProperty({ description: "审计行 id", type: String })
	id!: string;

	@ApiProperty({ description: "组织 id", type: String })
	organizationId!: string;

	@ApiPropertyOptional({
		description: "操作者 userId（系统动作为 null）",
		type: String,
		nullable: true,
	})
	actorUserId!: string | null;

	@ApiProperty({
		description: "操作者类型",
		enum: ["USER", "API", "AGENT"],
		type: String,
	})
	actorType!: string;

	@ApiProperty({
		description: "动作（如 organization.update、member.invite）",
		type: String,
	})
	action!: string;

	@ApiPropertyOptional({
		description: "目标类型",
		type: String,
		nullable: true,
	})
	targetType!: string | null;

	@ApiPropertyOptional({
		description: "目标 id",
		type: String,
		nullable: true,
	})
	targetId!: string | null;

	@ApiProperty({ description: "结果", enum: AUDIT_RESULTS, type: String })
	result!: string;

	@ApiPropertyOptional({
		description: "关联请求 id",
		type: String,
		nullable: true,
	})
	requestId!: string | null;

	@ApiPropertyOptional({
		description: "关联 Agent 运行 id",
		type: String,
		nullable: true,
	})
	agentRunId!: string | null;

	@ApiPropertyOptional({
		description: "脱敏后的白名单摘要（键值开放对象）",
		type: "object",
		additionalProperties: true,
		nullable: true,
	})
	detail!: Record<string, unknown> | null;

	@ApiProperty({ description: "创建时间（UTC ISO）", type: String, format: "date-time" })
	createdAt!: string;
}

/** 审计分页查询参数（AUDIT-03.1：按时间起止、成员、动作筛选；分页不返回全量） */
export class ListAuditLogsQueryDto {
	@ApiPropertyOptional({ description: "页码（从 1 起）", example: 1, type: Number })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({
		description: "每页条数（1-100，默认 20）",
		example: 20,
		type: Number,
	})
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	@IsOptional()
	pageSize?: number;

	@ApiPropertyOptional({
		description: "起始时间（ISO 8601，含）",
		example: "2026-11-23T00:00:00.000Z",
		type: String,
	})
	@IsISO8601()
	@IsOptional()
	from?: string;

	@ApiPropertyOptional({
		description: "截止时间（ISO 8601，含）",
		example: "2026-11-23T23:59:59.000Z",
		type: String,
	})
	@IsISO8601()
	@IsOptional()
	to?: string;

	@ApiPropertyOptional({ description: "按操作者 userId 精确筛选", type: String })
	@IsString()
	@IsOptional()
	actorUserId?: string;

	@ApiPropertyOptional({ description: "按动作精确筛选", type: String })
	@IsString()
	@IsOptional()
	action?: string;

	@ApiPropertyOptional({ description: "按结果筛选", enum: AUDIT_RESULTS, type: String })
	@IsIn(AUDIT_RESULTS)
	@IsOptional()
	result?: string;
}

/** 审计分页响应（含分页元信息；永不返回 tokenHash 等敏感键） */
export class AuditLogListDto {
	@ApiProperty({ type: [AuditLogViewDto] })
	items!: AuditLogViewDto[];

	@ApiProperty({ description: "当前页码", example: 1, type: Number })
	page!: number;

	@ApiProperty({ description: "每页条数", example: 20, type: Number })
	pageSize!: number;

	@ApiProperty({ description: "总条数", example: 42, type: Number })
	total!: number;
}
