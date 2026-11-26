import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
	DEFAULT_PLAN_FORM_VALUES,
	isPacePreference,
	localTodayYmd,
	PACE_PREFERENCES,
	parsePlanDraftQuery,
	toPacePreference,
	usePlanForm,
	validatePlanForm,
	type PlanFormValues,
} from "./use-plan-form";

/** 合法基线（日期取远未来，避免依赖测试执行日的时区/当天值） */
const validValues: PlanFormValues = {
	name: "",
	targetCurrency: "USD",
	targetAmount: "50000",
	expectUseDate: "2030-08-01",
	prepLeadDays: "3",
	pacePreference: "balanced",
	allocatedAmount: "0",
};

/** 本地时区相对今天偏移 n 天的 yyyy-MM-dd */
function shiftDays(days: number): string {
	const date = new Date();
	date.setDate(date.getDate() + days);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

describe("localTodayYmd", () => {
	it("应返回本地时区今天的 yyyy-MM-dd", () => {
		expect(localTodayYmd()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(localTodayYmd()).toBe(shiftDays(0));
	});
});

describe("isPacePreference", () => {
	it("三档合法值应通过，其余拒绝（存量 prepPreference 无枚举约束）", () => {
		expect(isPacePreference("conservative")).toBe(true);
		expect(isPacePreference("balanced")).toBe(true);
		expect(isPacePreference("aggressive")).toBe(true);
		expect(isPacePreference("unknown")).toBe(false);
		expect(isPacePreference("")).toBe(false);
		expect(isPacePreference(null)).toBe(false);
		expect(isPacePreference(undefined)).toBe(false);
	});
});

describe("toPacePreference（FE-03 跨域同义桥）", () => {
	it("pace 本域值原样返回", () => {
		expect(toPacePreference("conservative")).toBe("conservative");
		expect(toPacePreference("balanced")).toBe("balanced");
		expect(toPacePreference("aggressive")).toBe("aggressive");
	});

	it("settings prep 同义词映射（cautious→conservative、proactive→aggressive）", () => {
		expect(toPacePreference("cautious")).toBe("conservative");
		expect(toPacePreference("proactive")).toBe("aggressive");
	});

	it("非法值（含空串/未知词）返回 null", () => {
		expect(toPacePreference("")).toBeNull();
		expect(toPacePreference("risky")).toBeNull();
		expect(toPacePreference(undefined)).toBeNull();
		expect(toPacePreference(42)).toBeNull();
	});

	it("PACE_PREFERENCES 与后端契约三档一致且顺序稳定", () => {
		expect([...PACE_PREFERENCES]).toEqual([
			"conservative",
			"balanced",
			"aggressive",
		]);
	});
});

describe("validatePlanForm", () => {
	it("合法基线应无任何错误", () => {
		expect(validatePlanForm(validValues, null)).toEqual({});
	});

	it("targetAmount：必填、> 0 且 < 1e11、格式合法", () => {
		expect(
			validatePlanForm({ ...validValues, targetAmount: "" }, null),
		).toHaveProperty("targetAmount");
		expect(
			validatePlanForm({ ...validValues, targetAmount: "0" }, null),
		).toHaveProperty("targetAmount");
		expect(
			validatePlanForm({ ...validValues, targetAmount: "-100" }, null),
		).toHaveProperty("targetAmount");
		expect(
			validatePlanForm({ ...validValues, targetAmount: "abc" }, null),
		).toHaveProperty("targetAmount");
		// 上限 1e11 不含：等于报错，略小通过
		expect(
			validatePlanForm({ ...validValues, targetAmount: "100000000000" }, null),
		).toHaveProperty("targetAmount");
		expect(
			validatePlanForm({ ...validValues, targetAmount: "99999999999" }, null),
		).not.toHaveProperty("targetAmount");
	});

	it("expectUseDate：必填、格式合法且须晚于今天（本地时区）", () => {
		expect(
			validatePlanForm({ ...validValues, expectUseDate: "" }, null),
		).toHaveProperty("expectUseDate");
		expect(
			validatePlanForm({ ...validValues, expectUseDate: "2030/08/01" }, null),
		).toHaveProperty("expectUseDate");
		expect(
			validatePlanForm({ ...validValues, expectUseDate: shiftDays(0) }, null),
		).toHaveProperty("expectUseDate");
		expect(
			validatePlanForm({ ...validValues, expectUseDate: shiftDays(-1) }, null),
		).toHaveProperty("expectUseDate");
		expect(
			validatePlanForm({ ...validValues, expectUseDate: shiftDays(1) }, null),
		).not.toHaveProperty("expectUseDate");
	});

	it("prepLeadDays：须为 1~30 的整数", () => {
		expect(
			validatePlanForm({ ...validValues, prepLeadDays: "" }, null),
		).toHaveProperty("prepLeadDays");
		expect(
			validatePlanForm({ ...validValues, prepLeadDays: "0" }, null),
		).toHaveProperty("prepLeadDays");
		expect(
			validatePlanForm({ ...validValues, prepLeadDays: "31" }, null),
		).toHaveProperty("prepLeadDays");
		expect(
			validatePlanForm({ ...validValues, prepLeadDays: "2.5" }, null),
		).toHaveProperty("prepLeadDays");
		expect(
			validatePlanForm({ ...validValues, prepLeadDays: "1" }, null),
		).not.toHaveProperty("prepLeadDays");
		expect(
			validatePlanForm({ ...validValues, prepLeadDays: "30" }, null),
		).not.toHaveProperty("prepLeadDays");
	});

	it("allocatedAmount：空串视为 0，须 ≥ 0 且 ≤ caps.maxAllocatable", () => {
		const caps = { allocatableBalance: "4000.00", maxAllocatable: "4000.00" };
		// 空串按 "0" 处理：合法
		expect(
			validatePlanForm({ ...validValues, allocatedAmount: "" }, caps),
		).not.toHaveProperty("allocatedAmount");
		expect(
			validatePlanForm({ ...validValues, allocatedAmount: "4000" }, caps),
		).not.toHaveProperty("allocatedAmount");
		expect(
			validatePlanForm({ ...validValues, allocatedAmount: "4000.01" }, caps),
		).toHaveProperty("allocatedAmount");
		expect(
			validatePlanForm({ ...validValues, allocatedAmount: "-5" }, caps),
		).toHaveProperty("allocatedAmount");
	});

	it("caps 未就绪时跳过 allocatedAmount 上限校验", () => {
		expect(
			validatePlanForm({ ...validValues, allocatedAmount: "999999999" }, null),
		).not.toHaveProperty("allocatedAmount");
	});
});

describe("usePlanForm", () => {
	it("初始值应为默认值，且因必填缺失 isValid=false", () => {
		const { result } = renderHook(() => usePlanForm());

		expect(result.current.values).toEqual(DEFAULT_PLAN_FORM_VALUES);
		expect(result.current.isValid).toBe(false);
	});

	it("setField 应更新值并标记 touched", () => {
		const { result } = renderHook(() => usePlanForm());

		act(() => {
			result.current.setField("targetAmount", "100");
		});

		expect(result.current.values.targetAmount).toBe("100");
		expect(result.current.touched.targetAmount).toBe(true);
	});

	it("setField 传 touch:false 时程序化回填不标记 touched（默认节奏防覆盖依赖此语义）", () => {
		const { result } = renderHook(() => usePlanForm());

		act(() => {
			result.current.setField("pacePreference", "conservative", {
				touch: false,
			});
		});

		expect(result.current.values.pacePreference).toBe("conservative");
		expect(result.current.touched.pacePreference).toBeUndefined();
	});

	it("getError：字段未触碰且无值时不显示错误（避免初始全红）", () => {
		const { result } = renderHook(() => usePlanForm());

		// 初始 targetAmount 为空且未触碰 → 不暴露错误
		expect(result.current.getError("targetAmount")).toBeUndefined();

		// 触碰后（失焦/输入空值）→ 暴露必填错误
		act(() => {
			result.current.setField("targetAmount", "");
		});
		expect(result.current.getError("targetAmount")).toBe("请输入净到账金额");

		// 未触碰但有值（默认值/回填）→ 错误照常暴露
		act(() => {
			result.current.setField("prepLeadDays", "0", { touch: false });
		});
		expect(result.current.getError("prepLeadDays")).toContain("1~30");
	});

	it("setCaps 就绪后启用 allocatedAmount 上限校验；未就绪时跳过", () => {
		const { result } = renderHook(() => usePlanForm());

		act(() => {
			result.current.setField("allocatedAmount", "5000");
			result.current.setCaps({
				allocatableBalance: "4000.00",
				maxAllocatable: "4000.00",
			});
		});
		expect(result.current.getError("allocatedAmount")).toBe(
			"超出可分配上限，请调低金额",
		);

		act(() => {
			result.current.setCaps(null);
		});
		expect(result.current.getError("allocatedAmount")).toBeUndefined();
	});

	it("必填字段全部合法后 isValid=true", () => {
		const { result } = renderHook(() => usePlanForm());

		act(() => {
			result.current.setField("targetCurrency", "USD");
			result.current.setField("targetAmount", "50000");
			result.current.setField("expectUseDate", shiftDays(1));
		});

		expect(result.current.isValid).toBe(true);
	});

	it("传入 initialValues 时预填值生效且字段默认 touched=true（防止 onboarding 回填覆盖草稿节奏）", () => {
		const { result } = renderHook(() =>
			usePlanForm({
				targetCurrency: "USD",
				targetAmount: "10000",
				expectUseDate: "2030-12-10",
				pacePreference: "aggressive",
			}),
		);

		expect(result.current.values.targetCurrency).toBe("USD");
		expect(result.current.values.pacePreference).toBe("aggressive");
		expect(result.current.touched.pacePreference).toBe(true);
		expect(result.current.isValid).toBe(true);
	});
});

describe("parsePlanDraftQuery（AI 计划草稿参数解析）", () => {
	it("缺少 fromDraft=1 或 sourceOrgId 不匹配当前组织时返回空状态（防切组织串用草稿）", () => {
		expect(
			parsePlanDraftQuery(
				new URLSearchParams("targetCurrency=USD&sourceOrgId=org-a"),
				"org-a",
			),
		).toEqual({
			fromDraft: false,
			agentRunId: null,
			initialValues: {},
		});

		// 组织 A 的草稿 URL 在切换为组织 B 后一律忽略，不得带入 agentRunId 或表单字段
		expect(
			parsePlanDraftQuery(
				new URLSearchParams({
					fromDraft: "1",
					sourceOrgId: "org-a",
					agentRunId: "run_12345678",
					targetCurrency: "USD",
					targetAmount: "10000",
				}),
				"org-b",
			),
		).toEqual({
			fromDraft: false,
			agentRunId: null,
			initialValues: {},
		});

		// 缺失 sourceOrgId 或 activeOrgId 同样 fail-closed 忽略
		expect(
			parsePlanDraftQuery(
				new URLSearchParams({
					fromDraft: "1",
					agentRunId: "run_12345678",
					targetCurrency: "USD",
				}),
				"org-a",
			),
		).toEqual({
			fromDraft: false,
			agentRunId: null,
			initialValues: {},
		});
	});

	it("合法草稿参数（且 sourceOrgId === activeOrgId）完整解析，非法字段安全忽略", () => {
		const parsed = parsePlanDraftQuery(
			new URLSearchParams({
				fromDraft: "1",
				sourceOrgId: "org-a",
				agentRunId: "run_12345678",
				name: "12月广告费",
				targetCurrency: "usd",
				targetAmount: "10000",
				expectUseDate: "2030-12-10T00:00:00.000Z",
				prepLeadDays: "5",
				pacePreference: "conservative",
				allocatedAmount: "2000.0000",
			}),
			"org-a",
		);
		expect(parsed).toEqual({
			fromDraft: true,
			agentRunId: "run_12345678",
			initialValues: {
				name: "12月广告费",
				targetCurrency: "USD",
				targetAmount: "10000",
				expectUseDate: "2030-12-10",
				prepLeadDays: "5",
				pacePreference: "conservative",
				allocatedAmount: "2000.0000",
			},
		});

		const dirty = parsePlanDraftQuery(
			new URLSearchParams({
				fromDraft: "1",
				sourceOrgId: "org-a",
				agentRunId: "bad id!",
				targetCurrency: "BTC",
				targetAmount: "-1",
				expectUseDate: "not-a-date",
				prepLeadDays: "99",
				pacePreference: "invalid",
				allocatedAmount: "NaN",
			}),
			"org-a",
		);
		expect(dirty).toEqual({
			fromDraft: true,
			agentRunId: null,
			initialValues: {},
		});
	});
});
