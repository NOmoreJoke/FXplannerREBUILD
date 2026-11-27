import { HttpException, type Logger } from "@nestjs/common";
import type { AuditService } from "../../audit/audit.service";
import {
	type ActorContext,
	isOrganizationRole,
	type OrganizationRole,
	type Permission,
} from "../../authorization/authorization.types";
import type { OrganizationLockResolver } from "../../authorization/guards/organization-lock.guard";
import { can } from "../../authorization/permission-policy";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Agent 工具闭包上下文（技术方案 §8.1）：
 * 由服务端请求鉴权入口构建并注入工具工厂闭包；
 * 仅携带不可变的发起人 userId / organizationId 及链路追踪 ID，
 * 每次工具执行前必须在 tool-guard 中实时重查 Membership、双锁与最新角色。
 */
export interface AgentToolContext {
	actor: ActorContext;
	conversationId: string;
	agentRunId: string;
	requestId: string | null;
}

export interface ToolGuardDeps {
	prisma: Pick<PrismaService, "membership">;
	auditService: Pick<AuditService, "recordStandalone">;
	lockResolver: OrganizationLockResolver;
	orgToolsEnabled: boolean;
	logger?: Pick<Logger, "warn">;
}

export interface AuthorizedToolOptions<TResult> {
	toolName: string;
	scope: "public" | "organization";
	requiredPermissions: readonly Permission[];
	auditDetail?: Record<string, unknown>;
	run: (freshActor: ActorContext) => Promise<TResult>;
}

/** 统一错误输出（纯 JSON 文本回喂模型，禁止暴露 SQL / 堆栈 / 密钥 / 他组织 ID） */
export function formatAgentToolError(code: string, message: string): string {
	return JSON.stringify({ error: code, message });
}

function extractSafeHttpError(error: HttpException): {
	code: string;
	message: string;
} {
	const response = error.getResponse();
	if (typeof response === "object" && response !== null) {
		const record = response as Record<string, unknown>;
		const code =
			typeof record.code === "string" && record.code.length > 0
				? record.code
				: "TOOL_REQUEST_REJECTED";
		const message =
			typeof record.message === "string" && record.message.length > 0
				? record.message
				: "请求被拒绝，请向用户如实说明原因，禁止编造数字。";
		return { code, message };
	}
	return {
		code: "TOOL_REQUEST_REJECTED",
		message: "请求被拒绝，请向用户如实说明原因，禁止编造数字。",
	};
}

async function recordToolAuditBestEffort(
	deps: Pick<ToolGuardDeps, "auditService" | "logger">,
	ctx: AgentToolContext,
	params: {
		action: string;
		result: "SUCCESS" | "DENIED" | "FAILED";
		detail?: Record<string, unknown>;
	},
): Promise<void> {
	try {
		await deps.auditService.recordStandalone({
			organizationId: ctx.actor.organizationId,
			actorUserId: ctx.actor.userId,
			actorType: "AGENT",
			action: params.action,
			targetType: "ai_conversation",
			targetId: ctx.conversationId,
			result: params.result,
			requestId: ctx.requestId,
			agentRunId: ctx.agentRunId,
			detail: params.detail ?? null,
		});
	} catch (error) {
		deps.logger?.warn(
			`Agent 工具审计写入失败 action=${params.action} result=${params.result}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function buildDeniedMessage(
	toolName: string,
	role: OrganizationRole,
	requiredPermission: Permission,
): string {
	if (toolName === "draft_fx_plan" || requiredPermission === "agent.draft") {
		return `当前成员角色（${role}）没有计划草稿保存权限（缺少 ${requiredPermission}），严禁宣称已创建或保存任何计划；只可在正文中给出纯文字参考建议，并明确说明当前只读角色无法保存为正式计划。`;
	}
	return `当前成员角色（${role}）无权调用 ${toolName}（缺少 ${requiredPermission}），请如实告知用户无权访问，严禁编造任何数值。`;
}

/**
 * Agent 工具级实时鉴权 + 双锁 + 降级开关 + 审计执行器（技术方案 §8.3/§8.4，需求 §7.4/§9.4/§10.1）。
 *
 * 执行顺序（fail-closed）：
 * 1. 双锁检查（个人注销锁 / 组织清空删除锁）——组织锁拦截所有组织工具；
 * 2. 实时重查 Membership（organizationId + userId）——流式期间移除/DISABLED/降权立即生效；
 * 3. 组织工具独立降级开关检查（AI_ORG_TOOLS_ENABLED=false 时放行公共汇率、拦截组织工具）；
 * 4. 集中权限策略检查 `can(freshRole, perm)`；
 * 5. 调用包装后的只读/草稿业务逻辑（注入 freshActor，不信任模型入参）；
 * 6. 落盘 `AuditLog`（`actorType="AGENT"`, `agentRunId`；组织工具记录 SUCCESS/DENIED/FAILED，公共工具拒绝时记录 DENIED）。
 */
export async function executeAuthorizedTool<TResult>(
	deps: ToolGuardDeps,
	ctx: AgentToolContext,
	options: AuthorizedToolOptions<TResult>,
): Promise<string> {
	const action = `agent.tool.${options.toolName}`;
	const baseDetail: Record<string, unknown> = {
		tool: options.toolName,
		scope: options.scope,
		...(options.auditDetail ?? {}),
	};

	// 1. 双锁检查（个人注销锁 / 组织数据锁）
	let lockResolution;
	try {
		lockResolution = await deps.lockResolver.resolve(
			{
				userId: ctx.actor.userId,
				organizationId: ctx.actor.organizationId,
			},
			{ method: "POST" },
		);
	} catch (error) {
		deps.logger?.warn(
			`Agent 工具锁判定失败 tool=${options.toolName}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return formatAgentToolError(
			"LOCK_CHECK_FAILED",
			"安全状态校验失败，暂无法执行工具查询，请稍后重试并勿编造数据。",
		);
	}

	if (lockResolution.userDeleted || lockResolution.personalLock !== null) {
		if (!lockResolution.organizationDeleted) {
			await recordToolAuditBestEffort(deps, ctx, {
				action,
				result: "DENIED",
				detail: { ...baseDetail, reason: "ACCOUNT_PENDING_DELETION" },
			});
		}
		return formatAgentToolError(
			"ACCOUNT_PENDING_DELETION",
			"当前个人账号处于注销锁定或已删除状态，无法执行工具查询，请如实告知用户。",
		);
	}

	if (lockResolution.organizationDeleted) {
		return formatAgentToolError(
			"ORGANIZATION_NOT_FOUND",
			"当前组织不存在或已被删除，无法查询组织数据，请如实告知用户。",
		);
	}

	if (
		options.scope === "organization" &&
		(lockResolution.organizationLock !== null ||
			lockResolution.organizationLockSummary.active)
	) {
		await recordToolAuditBestEffort(deps, ctx, {
			action,
			result: "DENIED",
			detail: {
				...baseDetail,
				reason: "ORGANIZATION_DATA_LOCKED",
				lockType: lockResolution.organizationLockSummary.type,
			},
		});
		return formatAgentToolError(
			"ORGANIZATION_DATA_LOCKED",
			"当前组织正在进行数据清空或删除处理，组织数据工具已锁定不可用，请如实告知用户且严禁编造数字。",
		);
	}

	// 2. 实时重查 Membership 与角色（流中途降权/移除即刻拦截）
	let membership: { id: string; role: string; status: string } | null;
	try {
		membership = await deps.prisma.membership.findUnique({
			where: {
				organizationId_userId: {
					organizationId: ctx.actor.organizationId,
					userId: ctx.actor.userId,
				},
			},
			select: { id: true, role: true, status: true },
		});
	} catch (error) {
		deps.logger?.warn(
			`Agent 工具成员实时校验失败 tool=${options.toolName}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return formatAgentToolError(
			"MEMBERSHIP_CHECK_FAILED",
			"成员权限校验失败，无法执行工具查询，请稍后重试。",
		);
	}

	if (
		!membership ||
		membership.status !== "ACTIVE" ||
		!isOrganizationRole(membership.role)
	) {
		await recordToolAuditBestEffort(deps, ctx, {
			action,
			result: "DENIED",
			detail: {
				...baseDetail,
				reason: !membership
					? "MEMBERSHIP_MISSING"
					: membership.status !== "ACTIVE"
						? "MEMBERSHIP_DISABLED"
						: "INVALID_ROLE",
			},
		});
		return formatAgentToolError(
			"PERMISSION_DENIED",
			"当前成员在该组织的访问权限已失效或已被移除，无法获取组织数据，请明确告知用户且严禁编造数字。",
		);
	}

	const freshRole: OrganizationRole = membership.role;
	const freshActor: ActorContext = {
		userId: ctx.actor.userId,
		organizationId: ctx.actor.organizationId,
		membershipId: membership.id,
		role: freshRole,
		authMethod: ctx.actor.authMethod,
	};

	// 3. 独立组织工具降级开关（关闭时放行公共汇率、拦截组织工具）
	if (options.scope === "organization" && !deps.orgToolsEnabled) {
		await recordToolAuditBestEffort(deps, ctx, {
			action,
			result: "DENIED",
			detail: {
				...baseDetail,
				role: freshRole,
				reason: "AI_ORG_TOOLS_DISABLED",
			},
		});
		return formatAgentToolError(
			"AI_ORG_TOOLS_DISABLED",
			"组织业务工具当前已临时关闭，仅支持公共汇率查询，请如实说明且严禁编造组织数据。",
		);
	}

	// 4. 集中权限策略检查
	for (const requiredPermission of options.requiredPermissions) {
		if (!can(freshRole, requiredPermission)) {
			await recordToolAuditBestEffort(deps, ctx, {
				action,
				result: "DENIED",
				detail: {
					...baseDetail,
					role: freshRole,
					requiredPermission,
					reason: "PERMISSION_DENIED",
				},
			});
			return formatAgentToolError(
				"PERMISSION_DENIED",
				buildDeniedMessage(options.toolName, freshRole, requiredPermission),
			);
		}
	}

	// 5. 执行实际工具逻辑
	const startedAt = Date.now();
	try {
		const result = await options.run(freshActor);
		const latencyMs = Date.now() - startedAt;
		if (options.scope === "organization") {
			await recordToolAuditBestEffort(deps, ctx, {
				action,
				result: "SUCCESS",
				detail: {
					...baseDetail,
					role: freshRole,
					latencyMs,
				},
			});
		}
		return typeof result === "string" ? result : JSON.stringify(result);
	} catch (error) {
		const latencyMs = Date.now() - startedAt;
		if (error instanceof HttpException) {
			const safe = extractSafeHttpError(error);
			await recordToolAuditBestEffort(deps, ctx, {
				action,
				result: "FAILED",
				detail: {
					...baseDetail,
					role: freshRole,
					latencyMs,
					errorCode: safe.code,
				},
			});
			return formatAgentToolError(safe.code, safe.message);
		}
		deps.logger?.warn(
			`Agent 工具执行异常 tool=${options.toolName} org=${ctx.actor.organizationId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		await recordToolAuditBestEffort(deps, ctx, {
			action,
			result: "FAILED",
			detail: {
				...baseDetail,
				role: freshRole,
				latencyMs,
				errorCode: "TOOL_EXECUTION_FAILED",
			},
		});
		return formatAgentToolError(
			"TOOL_EXECUTION_FAILED",
			"组织数据查询暂时失败，请如实告知用户稍后重试，禁止编造数值。",
		);
	}
}

export type ToolGuardRunner = <TResult>(
	options: AuthorizedToolOptions<TResult>,
) => Promise<string>;

export function createToolGuardRunner(
	deps: ToolGuardDeps,
	ctx: AgentToolContext,
): ToolGuardRunner {
	return <TResult>(options: AuthorizedToolOptions<TResult>) =>
		executeAuthorizedTool(deps, ctx, options);
}
