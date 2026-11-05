import { ShieldCheck } from "lucide-react";

/**
 * 最小合规免责声明（阶段5 / backlog P0-5，2026-11-05 终审候选稿）
 *
 * 落地页、登录后首页、报告页三处共用（≥2 处复用，进 base）。
 * 措辞要求（Goal 2026-11-05）：非持牌、非投顾、汇率/计划仅工具测算、损失自负。
 * 默认采用 A 版；B 版候选与终审状态见 docs/handoff/DISCLAIMER-CANDIDATES-20261105.md，
 * Kaiming 选定后只改 COMPLIANCE_DISCLAIMER_TEXT 一处。纯展示无状态，服务端组件可直接渲染。
 */

/** 免责短句（A 版终审候选，70 字）：改措辞只动此常量 */
export const COMPLIANCE_DISCLAIMER_TEXT =
	"本工具由非持牌主体提供，非投资顾问服务；汇率与计划均为工具测算，不构成投资建议、不预测涨跌、不经手资金；据此操作的风险与损失由用户自行承担。";

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
