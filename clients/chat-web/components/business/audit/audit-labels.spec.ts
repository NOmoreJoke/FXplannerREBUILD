import { describe, expect, it } from "vitest";
import {
	formatAuditActionLabel,
	formatAuditResultLabel,
	formatAuditTargetLabel,
} from "./audit-labels";

describe("audit-labels（审计枚举中文化）", () => {
	it("正确映射结果枚举与目标类型（含大小写与空值）", () => {
		expect(formatAuditResultLabel("SUCCESS")).toBe("成功");
		expect(formatAuditResultLabel("DENIED")).toBe("已拒绝");
		expect(formatAuditResultLabel("FAILED")).toBe("失败");
		expect(formatAuditResultLabel("OTHER")).toBe("OTHER");

		expect(formatAuditTargetLabel("TRANSACTION")).toBe("换汇记录");
		expect(formatAuditTargetLabel("usage_record")).toBe("使用记录");
		expect(formatAuditTargetLabel("organization_settings")).toBe("组织设置");
		expect(formatAuditTargetLabel(null)).toBe("—");
	});

	it("正确映射精确动作编码与前缀规则", () => {
		expect(formatAuditActionLabel("plan.create")).toBe("创建换汇计划");
		expect(formatAuditActionLabel("correction.apply")).toBe("应用账本更正");
		expect(formatAuditActionLabel("permission.denied.plan.create")).toBe(
			"权限不足被拒绝",
		);
		expect(formatAuditActionLabel("agent.tool.draft_fx_plan")).toBe(
			"AI 工具调用",
		);
		expect(formatAuditActionLabel("data_request.export.create")).toBe(
			"数据权利操作",
		);
		expect(formatAuditActionLabel("custom.action")).toBe("custom.action");
	});
});
