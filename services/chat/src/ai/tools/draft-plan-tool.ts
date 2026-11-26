import { tool } from "@langchain/core/tools";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { resolveOrganizationPreferences } from "../../organization/organization-preferences";
import {
	PlanAmountTooSmallException,
	type PlanService,
} from "../../plan/plan.service";
import {
	PACE_PREFERENCES,
	type PacePreference,
} from "../../plan/schedule-builder";
import type { PrismaService } from "../../prisma/prisma.service";
import type { AiPlanDraftDto } from "../dto/ai.dto";
import { formatAgentToolError, type ToolGuardRunner } from "./tool-guard";

export const DRAFT_PLAN_TOOL_NAME = "draft_fx_plan";

function toPaceFromOrgPreference(prepPreference: string | undefined): PacePreference {
	if (prepPreference === "cautious" || prepPreference === "conservative") {
		return "conservative";
	}
	if (prepPreference === "proactive" || prepPreference === "aggressive") {
		return "aggressive";
	}
	return "balanced";
}

function normalizeExpectUseDate(raw: string): string | null {
	const trimmed = raw.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		return `${trimmed}T00:00:00.000Z`;
	}
	const parsed = new Date(trimmed);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return new Date(
		Date.UTC(
			parsed.getUTCFullYear(),
			parsed.getUTCMonth(),
			parsed.getUTCDate(),
		),
	).toISOString();
}

/**
 * 换汇计划草稿工具（ToB R2 P8；技术方案 §7.4 / §8.2）。
 *
 * 纪律：
 * - 仅调用只读排期预览 `PlanService.preview`，严禁调用 `PlanService.create` 落库；
 * - 校验 `agent.draft` 与 `plan.create` 权限（Viewer 明确拒绝）；
 * - 若生成了有效草稿，经闭包回调 `onDraft` 发送 SSE `draft` 帧并随助手消息落库 `planDraft`；
 * - 入参 schema `.strict()` 且禁含 userId/organizationId/role。
 */
export function createDraftPlanTool(params: {
	planService: PlanService;
	prisma: Pick<PrismaService, "organizationSettings">;
	guard: ToolGuardRunner;
	agentRunId: string;
	onDraft: (draft: AiPlanDraftDto) => void;
}) {
	return tool(
		async (input) => {
			const targetCurrency = input.targetCurrency.trim().toUpperCase();
			const targetAmount = input.targetAmount.trim();
			const expectUseDateIso = normalizeExpectUseDate(input.expectUseDate);
			if (!expectUseDateIso) {
				return formatAgentToolError(
					"INVALID_PLAN_PARAMS",
					"用途日期格式非法，请提供 YYYY-MM-DD 或 ISO 8601 日期。",
				);
			}
			const prepLeadDays = input.prepLeadDays ?? 3;
			if (
				input.pacePreference !== undefined &&
				!(PACE_PREFERENCES as readonly string[]).includes(input.pacePreference)
			) {
				return formatAgentToolError(
					"INVALID_PLAN_PARAMS",
					"pacePreference 仅支持 conservative、balanced、aggressive。",
				);
			}

			return params.guard({
				toolName: DRAFT_PLAN_TOOL_NAME,
				scope: "organization",
				requiredPermissions: [
					"agent.use",
					"agent.business_read",
					"agent.draft",
					"plan.create",
				],
				auditDetail: {
					targetCurrency,
					targetAmount,
					expectUseDate: expectUseDateIso.slice(0, 10),
				},
				run: async (freshActor) => {
					const preferences = await resolveOrganizationPreferences(
						params.prisma,
						freshActor.organizationId,
					);
					if (!preferences) {
						return {
							kind: "plan_draft_blocked",
							saved: false,
							code: "ONBOARDING_NOT_COMPLETED",
							message:
								"当前组织尚未完成首次建账，暂无法生成换汇计划草稿；请先完成首次建账后再试。",
						};
					}
					if (targetCurrency === preferences.baseCurrency) {
						return {
							kind: "plan_draft_blocked",
							saved: false,
							code: "INVALID_PLAN_PARAMS",
							message: `目标币种不能与组织本位币相同（当前本位币：${preferences.baseCurrency}）。`,
						};
					}

					const pacePreference: PacePreference =
						input.pacePreference ??
						toPaceFromOrgPreference(preferences.prepPreference);
					const basePreviewInput = {
						targetCurrency,
						targetAmount,
						expectUseDate: expectUseDateIso,
						prepLeadDays,
						pacePreference,
					};

					// 先用 allocatedAmount="0" 探知当前组织实时可分配上限 caps
					const zeroPreview = await params.planService.preview(freshActor, {
						...basePreviewInput,
						allocatedAmount: "0",
					});

					let requestedAllocated = "0";
					let noteSuffix = "";
					const maxAllocDecimal = new Prisma.Decimal(
						zeroPreview.caps.maxAllocatable,
					);
					const targetDecimal = new Prisma.Decimal(targetAmount);

					if (input.allocatedAmount !== undefined) {
						const rawAlloc = input.allocatedAmount.trim();
						try {
							const parsedAlloc = new Prisma.Decimal(rawAlloc);
							if (parsedAlloc.isFinite() && parsedAlloc.gt(0)) {
								if (parsedAlloc.gt(maxAllocDecimal)) {
									requestedAllocated = zeroPreview.caps.maxAllocatable;
									noteSuffix = `（原请求计入已有外币 ${rawAlloc} 超出当前可分配上限，已自动按最新上限 ${requestedAllocated} 调整）`;
								} else {
									requestedAllocated = rawAlloc;
								}
							}
						} catch {
							return {
								kind: "plan_draft_blocked",
								saved: false,
								code: "INVALID_PLAN_PARAMS",
								message: `allocatedAmount 格式非法：${input.allocatedAmount}`,
							};
						}
					} else if (input.includeExistingBalance === true && maxAllocDecimal.gt(0)) {
						// 若可分配余额已大于等于目标金额，直接计入会导致剩余排期为 0（AMOUNT_TOO_SMALL），此时回退 0 由人工决定
						if (maxAllocDecimal.lt(targetDecimal)) {
							requestedAllocated = zeroPreview.caps.maxAllocatable;
						}
					}

					let finalPreview = zeroPreview;
					let effectiveAllocated = "0.0000";
					if (requestedAllocated !== "0" && Number(requestedAllocated) > 0) {
						try {
							finalPreview = await params.planService.preview(freshActor, {
								...basePreviewInput,
								allocatedAmount: requestedAllocated,
							});
							effectiveAllocated = new Prisma.Decimal(
								requestedAllocated,
							).toFixed(4);
						} catch (error) {
							if (error instanceof PlanAmountTooSmallException) {
								finalPreview = zeroPreview;
								effectiveAllocated = "0.0000";
								noteSuffix =
									"（计入已有外币后剩余需分批金额过小，草稿暂按计入 0 生成，可在确认页手工调整）";
							} else {
								throw error;
							}
						}
					}

					const cleanName = input.name?.trim() ? input.name.trim().slice(0, 50) : null;
					const draft: AiPlanDraftDto = {
						agentRunId: params.agentRunId,
						name: cleanName,
						targetCurrency,
						targetAmount,
						expectUseDate: expectUseDateIso,
						prepLeadDays,
						pacePreference,
						allocatedAmount: effectiveAllocated,
						latestPrepDate: finalPreview.latestPrepDate,
						installments: finalPreview.installments,
						caps: finalPreview.caps,
					};
					params.onDraft(draft);

					return {
						kind: "plan_draft",
						saved: false,
						draft,
						note:
							`已生成换汇计划草稿（尚未保存、未改变任何账户分配）${noteSuffix}。` +
							"回答中必须明确称之为「草稿」或「建议」，并引导用户点击草稿卡片进入确认页复核最新余额后保存。",
					};
				},
			});
		},
		{
			name: DRAFT_PLAN_TOOL_NAME,
			description:
				"根据当前组织可用余额和偏好，为未来某天需要支付的外币生成换汇计划草稿（仅预览，不直接创建正式计划）。",
			schema: z
				.object({
					targetCurrency: z
						.string()
						.describe("目标外币 3 字母代码，如 USD、JPY"),
					targetAmount: z
						.string()
						.describe("需要准备的外币净到账金额字符串，如 10000"),
					expectUseDate: z
						.string()
						.describe("期望用汇日期，格式 YYYY-MM-DD 或 ISO 8601"),
					name: z
						.string()
						.optional()
						.describe("可选：计划名称，如 12月广告费换汇"),
					prepLeadDays: z
						.number()
						.int()
						.optional()
						.describe("可选：提前准备天数（1~30），默认 3"),
					pacePreference: z
						.enum(["conservative", "balanced", "aggressive"])
						.optional()
						.describe("可选：准备节奏，缺省跟随组织偏好"),
					allocatedAmount: z
						.string()
						.optional()
						.describe("可选：计入已有外币金额字符串"),
					includeExistingBalance: z
						.boolean()
						.optional()
						.describe("可选：是否自动计入当前可用未分配外币余额"),
				})
				.strict(),
		},
	);
}
