/**
 * buildInstallments / computeLatestPrepDate 单测（plan-management 技术方案 §8.1）。
 * M2 存量函数首次补测：#9（零头入尾批）+ R5 退化路径（2天/1天/0天）+ R6（某批取整为 0），
 * 兼顾 R1（可安排日期）/ R2（批次日期，偶数靠前）/ R3（节奏配比）/ R4（零头/整数币种）全分支。
 *
 * 日期锚定：today 注入 2026-09-16（周三）；星期参照——
 * 2026-09-17 周四、09-18 周五、09-19 周六、09-20 周日、09-21 周一、09-22 周二、
 * 2026-10-01 周四、2027-07-28 周三、2027-08-01 周日。
 */
import { getCurrency } from "@fxplanner-new/money";
import { Prisma } from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	ScheduleBuildError,
	buildInstallments,
	computeLatestPrepDate,
	type BuildInstallmentsInput,
	type PacePreference,
} from "./schedule-builder";

const TODAY = new Date("2026-09-16T00:00:00.000Z"); // 周三
const THU = new Date("2026-09-17T00:00:00.000Z");
const LATEST_FAR = new Date("2027-07-28T00:00:00.000Z"); // 2027-08-01（周日）往前 3 个工作日

function dec(value: string | number): Prisma.Decimal {
	return new Prisma.Decimal(value);
}

function build(
	overrides: Partial<BuildInstallmentsInput> = {},
): ReturnType<typeof buildInstallments> {
	return buildInstallments({
		targetAmount: dec("100"),
		allocatedAmount: dec("0"),
		decimalPlaces: 2,
		startDate: THU,
		latestPrepDate: LATEST_FAR,
		pacePreference: "balanced",
		today: TODAY,
		...overrides,
	});
}

function amountsOf(batches: ReturnType<typeof buildInstallments>): string[] {
	return batches.map((batch) => batch.amount.toFixed(2));
}

function expectBuildError(
	overrides: Partial<BuildInstallmentsInput>,
	code: ScheduleBuildError["code"],
): void {
	try {
		build(overrides);
	} catch (error) {
		expect(error).toBeInstanceOf(ScheduleBuildError);
		expect((error as ScheduleBuildError).code).toBe(code);
		return;
	}
	throw new Error(`预期抛出 ScheduleBuildError(${code})，但未抛错`);
}

/** 三批通用断言：seq 连续、日期升序、合计恒等于分批总额 */
function assertBatchInvariants(
	batches: ReturnType<typeof buildInstallments>,
	total: Prisma.Decimal,
): void {
	expect(batches.map((batch) => batch.seq)).toEqual([1, 2, 3]);
	const sum = batches.reduce(
		(sum, batch) => sum.add(batch.amount),
		new Prisma.Decimal(0),
	);
	expect(sum.toFixed(2)).toBe(total.toFixed(2));
}

// ────────────────────────── R2/R3/R4：节奏配比与零头 ──────────────────────────

describe("buildInstallments：R3 节奏配比 + R4 零头入尾批", () => {
	it("#9 零头入尾批：缺口 100 均分 → 33.33/33.33/33.34（例 07）", () => {
		const batches = build({ targetAmount: dec("100") });
		expect(amountsOf(batches)).toEqual(["33.33", "33.33", "33.34"]);
		assertBatchInvariants(batches, dec("100"));
	});

	it("R3 conservative 三批 50/30/20，零头全部入尾批", () => {
		const batches = build({
			targetAmount: dec("100.33"),
			pacePreference: "conservative",
		});
		// 50.165 → 50.16；30.099 → 30.09；尾批兜底 20.08
		expect(amountsOf(batches)).toEqual(["50.16", "30.09", "20.08"]);
		assertBatchInvariants(batches, dec("100.33"));
	});

	it("R3 aggressive 三批 20/30/50", () => {
		const batches = build({
			targetAmount: dec("100"),
			pacePreference: "aggressive",
		});
		expect(amountsOf(batches)).toEqual(["20.00", "30.00", "50.00"]);
	});

	it("R4 整数币种（JPY，decimalPlaces 0）：balanced 1000 → 333/333/334", () => {
		const batches = build({
			targetAmount: dec("1000"),
			decimalPlaces: 0,
			pacePreference: "balanced",
		});
		expect(batches.map((batch) => batch.amount.toFixed(0))).toEqual([
			"333",
			"333",
			"334",
		]);
	});

	it("R4：conservative JPY 1000 → 500/300/200（整除无零头）", () => {
		const batches = build({
			targetAmount: dec("1000"),
			decimalPlaces: 0,
			pacePreference: "conservative",
		});
		expect(batches.map((batch) => batch.amount.toFixed(0))).toEqual([
			"500",
			"300",
			"200",
		]);
	});

	it("R3：分批总额 = 目标 − 已使用 − 剩余分配（used 路径覆盖）", () => {
		const batches = build({
			targetAmount: dec("10000"),
			usedAmount: dec("4000"),
			allocatedAmount: dec("2000"), // 剩余分配
			pacePreference: "balanced",
		});
		// 分批总额 4000 → 等分
		expect(amountsOf(batches)).toEqual(["1333.33", "1333.33", "1333.34"]);
		assertBatchInvariants(batches, dec("4000"));
	});
});

describe.each([
	["JPY", 0],
	["KRW", 0],
	["USD", 2],
] as const)("buildInstallments：%s 分批金额守恒", (currency, decimalPlaces) => {
	const friday = new Date("2026-09-18T00:00:00.000Z");
	const monday = new Date("2026-09-21T00:00:00.000Z");

	it.each([
		["conservative", friday, [3n, 2n]],
		["balanced", friday, [1n, 1n]],
		["aggressive", friday, [2n, 3n]],
		["conservative", monday, [5n, 3n, 2n]],
		["balanced", monday, [1n, 1n, 1n]],
		["aggressive", monday, [2n, 3n, 5n]],
	] as const)(
		"%s 截至 %s，前批向下取整且尾批吸收全部零头",
		(pacePreference, latestPrepDate, weights) => {
			const currencyInfo = getCurrency(currency);
			expect(currencyInfo?.decimalPlaces).toBe(decimalPlaces);
			const scale = 10 ** decimalPlaces;
			const denominator = weights.reduce<bigint>(
				(sum, weight) => sum + weight,
				0n,
			);

			fc.assert(
				fc.property(
					fc.bigInt({ min: 1n, max: 1_000_000_000n }),
					fc.bigInt({ min: 1n, max: denominator - 1n }),
					fc.bigInt({ min: 0n, max: 1_000_000_000n }),
					fc.bigInt({ min: 0n, max: 1_000_000_000n }),
					(wholeShares, remainder, usedUnits, allocatedUnits) => {
						// 最小货币单位下不能整除配比分母，每轮都走到零头分配。
						const totalUnits = wholeShares * denominator + remainder;
						const batches = build({
							targetAmount: dec(String(totalUnits + usedUnits + allocatedUnits)).div(
								scale,
							),
							usedAmount: dec(String(usedUnits)).div(scale),
							allocatedAmount: dec(String(allocatedUnits)).div(scale),
							decimalPlaces,
							latestPrepDate,
							pacePreference,
						});
						expect(batches).toHaveLength(weights.length);
						const actualUnits = batches.map(({ amount }) => {
							expect(amount.decimalPlaces()).toBeLessThanOrEqual(
								decimalPlaces,
							);
							return BigInt(amount.mul(scale).toFixed());
						});
						expect(actualUnits.reduce((sum, units) => sum + units, 0n)).toBe(
							totalUnits,
						);

						// 用整数商和余数独立算出各批下取整值及全部被舍弃的零头。
						const shares = weights.map((weight) => totalUnits * weight);
						const floored = shares.map((share) => share / denominator);
						const discarded = shares.reduce(
							(sum, share) => sum + (share % denominator),
							0n,
						);
						const tailExtra = discarded / denominator;
						expect(tailExtra).toBeGreaterThan(0n);
						const tail = weights.length - 1;
						expect(actualUnits.slice(0, tail)).toEqual(floored.slice(0, tail));
						expect(actualUnits[tail]).toBe(floored[tail] + tailExtra);
					},
				),
				{ seed: 20261120, numRuns: 100 },
			);
		},
	);
});

// ────────────────────────── R1/R2：可安排日期与批次日期 ──────────────────────────

describe("buildInstallments：R1 可安排日期 + R2 批次日期", () => {
	it("R2/R1：首批 = 开始准备日，末批 = 最晚准备日，中间批为区间内工作日", () => {
		const batches = build();
		expect(batches[0].scheduledAt.toISOString()).toBe(THU.toISOString());
		expect(batches[2].scheduledAt.toISOString()).toBe(LATEST_FAR.toISOString());
		const middle = batches[1].scheduledAt;
		expect(middle.getTime()).toBeGreaterThan(THU.getTime());
		expect(middle.getTime()).toBeLessThan(LATEST_FAR.getTime());
		expect(middle.getUTCDay()).toBeGreaterThan(0);
		expect(middle.getUTCDay()).toBeLessThan(6); // 工作日
	});

	it("R2：可安排日为偶数（4 天）时中间取靠前（index 1，非 index 2）", () => {
		// 2026-09-21（周一）~ 2026-09-24（周四）共 4 个工作日；中间 = index 1 = 周二
		const batches = build({
			startDate: new Date("2026-09-21T00:00:00.000Z"),
			latestPrepDate: new Date("2026-09-24T00:00:00.000Z"),
		});
		expect(batches).toHaveLength(3);
		expect(batches[1].scheduledAt.toISOString()).toBe(
			"2026-09-22T00:00:00.000Z",
		);
	});

	it("R1：startDate 为 null → 最早可安排日 = 明天起首个工作日（注入 today 周三 → 周四）", () => {
		const batches = build({ startDate: null });
		expect(batches[0].scheduledAt.toISOString()).toBe(THU.toISOString());
	});
});

// ────────────────────────── R5：退化路径 ──────────────────────────

describe("buildInstallments：R5 退化路径", () => {
	const MON = new Date("2026-09-21T00:00:00.000Z");
	const TUE = new Date("2026-09-22T00:00:00.000Z");

	it("R5：2 天 → 两批（conservative 60/40）", () => {
		// 用途日周三、缓冲 1 天 → 最晚准备日周二；开始日周一 → [周一, 周二]
		const batches = build({
			targetAmount: dec("100"),
			startDate: MON,
			latestPrepDate: TUE,
			pacePreference: "conservative",
		});
		expect(batches).toHaveLength(2);
		expect(batches.map((batch) => batch.scheduledAt.toISOString())).toEqual([
			MON.toISOString(),
			TUE.toISOString(),
		]);
		expect(amountsOf(batches)).toEqual(["60.00", "40.00"]);
	});

	it("R5：2 天 → balanced 50/50、aggressive 40/60", () => {
		const twoDays = {
			startDate: MON,
			latestPrepDate: TUE,
		} as const;
		expect(amountsOf(build({ targetAmount: dec("100"), ...twoDays }))).toEqual([
			"50.00",
			"50.00",
		]);
		expect(
			amountsOf(
				build({
					targetAmount: dec("100"),
					...twoDays,
					pacePreference: "aggressive" as PacePreference,
				}),
			),
		).toEqual(["40.00", "60.00"]);
	});

	it("R5：1 天 → 单批 100%（三节奏一致）", () => {
		for (const pace of ["conservative", "balanced", "aggressive"] as const) {
			const batches = build({
				targetAmount: dec("100"),
				startDate: MON,
				latestPrepDate: MON, // 仅周一可安排
				pacePreference: pace,
			});
			expect(batches).toHaveLength(1);
			expect(batches[0].seq).toBe(1);
			expect(batches[0].scheduledAt.toISOString()).toBe(MON.toISOString());
			expect(batches[0].amount.toFixed(2)).toBe("100.00");
		}
	});

	it("R5：0 天（最晚准备日早于开始日）→ NO_AVAILABLE_DATES", () => {
		// 用途日周一、缓冲 1 天 → 最晚 = 周日；开始日周一 → 区间为空
		expectBuildError(
			{
				startDate: MON,
				latestPrepDate: new Date("2026-09-20T00:00:00.000Z"),
			},
			"NO_AVAILABLE_DATES",
		);
	});
});

// ────────────────────────── R6：金额过小 ──────────────────────────

describe("buildInstallments：R6 某批取整为 0 → AMOUNT_TOO_SMALL", () => {
	it("三批：0.01 balanced → 前两批取整 0.00", () => {
		expectBuildError({ targetAmount: dec("0.01") }, "AMOUNT_TOO_SMALL");
	});

	it("两批：0.01 balanced → 首批取整 0.00", () => {
		expectBuildError(
			{
				targetAmount: dec("0.01"),
				startDate: new Date("2026-09-21T00:00:00.000Z"),
				latestPrepDate: new Date("2026-09-22T00:00:00.000Z"),
			},
			"AMOUNT_TOO_SMALL",
		);
	});

	it("整数币种：2 JPY balanced 三等分 → 前两批取整 0", () => {
		expectBuildError(
			{ targetAmount: dec("2"), decimalPlaces: 0 },
			"AMOUNT_TOO_SMALL",
		);
	});

	it("分批总额 ≤ 0（分配已覆盖目标）→ AMOUNT_TOO_SMALL", () => {
		expectBuildError(
			{ targetAmount: dec("100"), allocatedAmount: dec("100") },
			"AMOUNT_TOO_SMALL",
		);
	});
});

// ────────────────────────── R7 + 防御性兜底 ──────────────────────────

describe("computeLatestPrepDate 与防御性校验", () => {
	it("R7：用途日 2027-08-01（周日）缓冲 3 → 2027-07-28（周三）", () => {
		expect(
			computeLatestPrepDate(new Date("2027-08-01T00:00:00.000Z"), 3),
		).toEqual(LATEST_FAR);
	});

	it("R7：跳过周末（用途日周三缓冲 5 → 本周三）", () => {
		// 回数：周二(1)、周一(2)、跳过周日/周六、周五(3)、周四(4)、周三(5)
		expect(
			computeLatestPrepDate(new Date("2026-09-23T00:00:00.000Z"), 5),
		).toEqual(new Date("2026-09-16T00:00:00.000Z"));
	});

	it("防御：prepLeadDays 越界（0/31/小数）→ INVALID_PLAN_PARAMS", () => {
		for (const prepLeadDays of [0, 31, 1.5]) {
			expect(() =>
				computeLatestPrepDate(
					new Date("2027-08-01T00:00:00.000Z"),
					prepLeadDays,
				),
			).toThrow(ScheduleBuildError);
		}
	});

	it("防御：目标金额 ≤ 0 / 分配为负 → INVALID_PLAN_PARAMS", () => {
		expectBuildError({ targetAmount: dec("0") }, "INVALID_PLAN_PARAMS");
		expectBuildError({ allocatedAmount: dec("-1") }, "INVALID_PLAN_PARAMS");
	});

	it("防御：可安排区间跨度过大 → INVALID_PLAN_PARAMS", () => {
		expectBuildError(
			{
				startDate: THU,
				latestPrepDate: new Date(THU.getTime() + 100_001 * 86_400_000),
			},
			"INVALID_PLAN_PARAMS",
		);
	});
});
