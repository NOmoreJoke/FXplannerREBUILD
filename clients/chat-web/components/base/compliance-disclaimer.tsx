import { ShieldCheck } from "lucide-react";

/**
 * 最小合规免责声明（阶段5 / backlog P0-5）
 *
 * 落地页、登录后首页、报告页三处共用（≥2 处复用，进 base）。
 * 措辞为最小合规短句，最终文案待 Kaiming 终审——改措辞只动
 * COMPLIANCE_DISCLAIMER_TEXT 一处。纯展示无状态，服务端组件可直接渲染。
 */

/** 免责短句（非投资建议 / 不预测涨跌 / 不经手资金，docs/imported-20261103/compliance 精神） */
export const COMPLIANCE_DISCLAIMER_TEXT =
	"本工具仅用于个人换汇记录与规划参考，不构成投资建议，不预测汇率涨跌，也不经手任何资金。";

export function ComplianceDisclaimer() {
	return (
		<div className="flex items-center gap-2 rounded-xl bg-mint-50 px-4 py-3">
			<ShieldCheck className="size-4 shrink-0 text-mint-700" />
			<p className="text-xs leading-5 text-ink-600">
				{COMPLIANCE_DISCLAIMER_TEXT}
			</p>
		</div>
	);
}
