export const AUDIT_RESULT_LABELS: Record<string, string> = {
	SUCCESS: "成功",
	DENIED: "已拒绝",
	FAILED: "失败",
};

const AUDIT_TARGET_LABELS: Record<string, string> = {
	organization: "组织",
	organization_settings: "组织设置",
	membership: "成员",
	invitation: "成员邀请",
	organization_invitation: "成员邀请",
	plan: "换汇计划",
	transaction: "换汇记录",
	initial_holding: "初始持仓",
	usage: "使用记录",
	usage_record: "使用记录",
	correction: "账本更正",
	data_request: "数据请求",
	ai_conversation: "AI 会话",
};

const AUDIT_ACTION_LABELS: Record<string, string> = {
	"organization.create": "创建组织",
	"organization.update": "更新组织信息",
	"member.update": "调整成员角色",
	"member.remove": "移除成员",
	"member.leave": "退出组织",
	"owner.transfer": "转移组织所有权",
	"invitation.create": "发送成员邀请",
	"invitation.revoke": "撤回成员邀请",
	"invitation.accept": "接受成员邀请",
	"invitation.decline": "拒绝成员邀请",
	"onboarding.complete": "完成首次建账",
	"onboarding.initial_holdings": "录入初始持仓",
	"settings.update": "更新账本设置",
	"plan.create": "创建换汇计划",
	"plan.adjust": "调整换汇计划",
	"plan.complete": "确认完成计划",
	"plan.cancel": "取消换汇计划",
	"transaction.create": "录入换汇买入",
	"usage.create": "记录资金使用",
	"correction.apply": "应用账本更正",
};

/** 审计结果枚举转中文 */
export function formatAuditResultLabel(result: string): string {
	return AUDIT_RESULT_LABELS[result] ?? result;
}

/** 审计目标类型转中文（大小写无关，null 返回破折号） */
export function formatAuditTargetLabel(
	targetType: string | null | undefined,
): string {
	if (!targetType) return "—";
	return AUDIT_TARGET_LABELS[targetType.toLowerCase()] ?? targetType;
}

/** 审计动作编码转中文业务语义（未匹配项保留原编码） */
export function formatAuditActionLabel(action: string): string {
	if (AUDIT_ACTION_LABELS[action]) return AUDIT_ACTION_LABELS[action];
	if (action.startsWith("permission.denied.")) return "权限不足被拒绝";
	if (action.startsWith("agent.tool.")) return "AI 工具调用";
	if (action.startsWith("data_request.")) return "数据权利操作";
	return action;
}
