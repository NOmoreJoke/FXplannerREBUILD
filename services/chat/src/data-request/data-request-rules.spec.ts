import { describe, expect, it } from "vitest";
import {
	ACTIVE_STATUSES,
	assertCredentialUsable,
	computeDueAt,
	resolveAdvance,
	resolveCancel,
	resolveCreationConflict,
	resolveDownload,
	resolveLock,
	toDisplayStatus,
	verifyChallengeCredential,
	type ExistingRequestLike,
} from "./data-request-rules";

const T0 = new Date("2026-01-15T08:00:00.000Z");

function existing(
	patch: Partial<ExistingRequestLike> = {},
): ExistingRequestLike {
	return {
		type: "CLEAR",
		status: "PENDING",
		downloadExpiresAt: null,
		...patch,
	};
}

describe("data-request-rules 互斥矩阵", () => {
	it.each(["PENDING", "PROCESSING", "FAILED"] as const)(
		"现有 %s 请求时创建任何类型一律拒绝",
		(status) => {
			for (const type of ["EXPORT", "CLEAR", "DELETION"] as const) {
				for (const existType of ["EXPORT", "CLEAR", "DELETION"] as const) {
					expect(
						resolveCreationConflict(
							type,
							existing({ type: existType, status }),
							T0,
						),
					).toEqual({ action: "block" });
				}
			}
		},
	);

	it("COMPLETED/CANCELLED 不阻塞新请求", () => {
		for (const status of ["COMPLETED", "CANCELLED"] as const) {
			expect(
				resolveCreationConflict("CLEAR", existing({ status }), T0),
			).toEqual({ action: "allow" });
		}
	});

	it("导出未过期时重复点击返回原请求（幂等，不新建）", () => {
		expect(
			resolveCreationConflict(
				"EXPORT",
				existing({
					type: "EXPORT",
					status: "COMPLETED",
					downloadExpiresAt: new Date(T0.getTime() + 1000),
				}),
				T0,
			),
		).toEqual({ action: "return-existing" });
	});

	it("导出已过期可重新申请", () => {
		expect(
			resolveCreationConflict(
				"EXPORT",
				existing({
					type: "EXPORT",
					status: "COMPLETED",
					downloadExpiresAt: new Date(T0.getTime() - 1000),
				}),
				T0,
			),
		).toEqual({ action: "allow" });
	});

	it("无既有请求放行", () => {
		expect(resolveCreationConflict("EXPORT", null, T0)).toEqual({
			action: "allow",
		});
	});

	it("ACTIVE_STATUSES 恰为三态", () => {
		expect(ACTIVE_STATUSES).toEqual(["PENDING", "PROCESSING", "FAILED"]);
	});
});

describe("data-request-rules 撤回可行性", () => {
	it("CLEAR PENDING 可直接撤回", () => {
		expect(resolveCancel({ type: "CLEAR", status: "PENDING" })).toBe("direct");
	});

	it("CLEAR PROCESSING/FAILED 不可撤回（开始清理后不能撤）", () => {
		expect(resolveCancel({ type: "CLEAR", status: "PROCESSING" })).toBe(
			"not-allowed",
		);
		expect(resolveCancel({ type: "CLEAR", status: "FAILED" })).toBe(
			"not-allowed",
		);
	});

	it("DELETION PENDING 可撤回且需验证码", () => {
		expect(resolveCancel({ type: "DELETION", status: "PENDING" })).toBe(
			"requires-verification",
		);
	});

	it("EXPORT 任何状态均无取消语义（同步生成）", () => {
		for (const status of [
			"PENDING",
			"PROCESSING",
			"COMPLETED",
			"CANCELLED",
			"FAILED",
		]) {
			expect(resolveCancel({ type: "EXPORT", status })).toBe("not-allowed");
		}
	});
});

describe("data-request-rules 读时推进判定", () => {
	it("PENDING 且 now ≥ dueAt → 推进", () => {
		expect(
			resolveAdvance({ type: "CLEAR", status: "PENDING", dueAt: T0 }, T0),
		).toBe("advance");
	});

	it("FAILED 且到期 → 重试推进", () => {
		expect(
			resolveAdvance({ type: "DELETION", status: "FAILED", dueAt: T0 }, T0),
		).toBe("advance");
	});

	it("now < dueAt → 不推进", () => {
		expect(
			resolveAdvance(
				{ type: "CLEAR", status: "PENDING", dueAt: new Date(T0.getTime() + 1) },
				T0,
			),
		).toBe("none");
	});

	it("EXPORT 不参与推进（同步生成无清理动作）", () => {
		expect(
			resolveAdvance({ type: "EXPORT", status: "PENDING", dueAt: T0 }, T0),
		).toBe("none");
		expect(
			resolveAdvance({ type: "EXPORT", status: "FAILED", dueAt: T0 }, T0),
		).toBe("none");
	});

	it("终态（COMPLETED/CANCELLED）不推进", () => {
		expect(
			resolveAdvance({ type: "CLEAR", status: "COMPLETED", dueAt: T0 }, T0),
		).toBe("none");
		expect(
			resolveAdvance({ type: "DELETION", status: "CANCELLED", dueAt: T0 }, T0),
		).toBe("none");
	});
});

describe("data-request-rules 展示映射", () => {
	it("DELETION PENDING → WITHDRAWAL_PERIOD（等待撤回期结束）", () => {
		expect(toDisplayStatus("DELETION", "PENDING")).toBe("WITHDRAWAL_PERIOD");
	});

	it("CLEAR PENDING → SUBMITTED（已提交可撤回）", () => {
		expect(toDisplayStatus("CLEAR", "PENDING")).toBe("SUBMITTED");
	});

	it("五态映射", () => {
		expect(toDisplayStatus("EXPORT", "PENDING")).toBe("SUBMITTED");
		expect(toDisplayStatus("CLEAR", "PROCESSING")).toBe("PROCESSING");
		expect(toDisplayStatus("EXPORT", "COMPLETED")).toBe("COMPLETED");
		expect(toDisplayStatus("CLEAR", "CANCELLED")).toBe("CANCELLED");
		expect(toDisplayStatus("DELETION", "FAILED")).toBe("FAILED");
	});
});

describe("data-request-rules 下载入口", () => {
	const exportDone = {
		id: "req-1",
		type: "EXPORT",
		status: "COMPLETED",
		downloadExpiresAt: new Date(T0.getTime() + 24 * 3600 * 1000),
	};

	it("EXPORT COMPLETED 未过期 → 下载入口", () => {
		expect(resolveDownload(exportDone, T0)).toEqual({
			url: "/api/data-requests/req-1/download",
			expiresAt: exportDone.downloadExpiresAt,
		});
	});

	it("过期后 download 为 null", () => {
		expect(resolveDownload(exportDone, new Date(T0.getTime() + 24 * 3600 * 1000 + 1))).toBeNull();
	});

	it("非 EXPORT 或非 COMPLETED 无下载入口", () => {
		expect(resolveDownload({ ...exportDone, type: "CLEAR" }, T0)).toBeNull();
		expect(resolveDownload({ ...exportDone, status: "PENDING" }, T0)).toBeNull();
	});
});

describe("data-request-rules 锁判定", () => {
	it("DELETION 三态全锁（ACCOUNT_PENDING_DELETION）", () => {
		for (const status of ["PENDING", "PROCESSING", "FAILED"]) {
			for (const method of ["GET", "POST"]) {
				expect(resolveLock({ type: "DELETION", status }, method)).toBe(
					"ACCOUNT_PENDING_DELETION",
				);
			}
		}
	});

	it("CLEAR PROCESSING/FAILED 全锁（DATA_REQUEST_LOCKED）", () => {
		for (const status of ["PROCESSING", "FAILED"]) {
			for (const method of ["GET", "POST"]) {
				expect(resolveLock({ type: "CLEAR", status }, method)).toBe(
					"DATA_REQUEST_LOCKED",
				);
			}
		}
	});

	it("CLEAR PENDING 仅锁非 GET（停写不停看）", () => {
		expect(resolveLock({ type: "CLEAR", status: "PENDING" }, "GET")).toBeNull();
		expect(resolveLock({ type: "CLEAR", status: "PENDING" }, "POST")).toBe(
			"DATA_REQUEST_LOCKED",
		);
		expect(resolveLock({ type: "CLEAR", status: "PENDING" }, "patch")).toBe(
			"DATA_REQUEST_LOCKED",
		);
	});

	it("无锁或终态放行", () => {
		expect(resolveLock(null, "POST")).toBeNull();
		expect(resolveLock({ type: "CLEAR", status: "COMPLETED" }, "POST")).toBeNull();
		expect(resolveLock({ type: "DELETION", status: "CANCELLED" }, "GET")).toBeNull();
	});
});

describe("data-request-rules dueAt 计算（+7 自然日）", () => {
	it("普通日期跨月", () => {
		expect(computeDueAt(new Date("2026-01-28T00:00:00.000Z"))).toEqual(
			new Date("2026-02-04T00:00:00.000Z"),
		);
	});

	it("跨年", () => {
		expect(computeDueAt(new Date("2026-12-30T12:00:00.000Z"))).toEqual(
			new Date("2027-01-06T12:00:00.000Z"),
		);
	});

	it("闰年 2 月（2024 含闰日）", () => {
		expect(computeDueAt(new Date("2024-02-26T00:00:00.000Z"))).toEqual(
			new Date("2024-03-04T00:00:00.000Z"),
		);
	});

	it("保留时刻分量", () => {
		expect(computeDueAt(new Date("2026-06-01T23:59:59.999Z"))).toEqual(
			new Date("2026-06-08T23:59:59.999Z"),
		);
	});
});

describe("data-request-rules 验证凭证窗口", () => {
	const challenge = {
		target: "user@example.com",
		purpose: "CLEAR",
		consumedAt: new Date(T0.getTime() - 60 * 1000), // 1 分钟前消费
	};

	it("消费后 10 分钟内通过，返回确认截止（consumedAt+10min）", () => {
		const result = verifyChallengeCredential(
			challenge,
			{ purpose: "CLEAR", userEmail: "user@example.com" },
			T0,
		);
		expect(result).toEqual({
			ok: true,
			confirmDeadline: new Date(T0.getTime() + 9 * 60 * 1000),
		});
	});

	it("超过 10 分钟拒绝（VERIFICATION_EXPIRED）", () => {
		const result = assertCredentialUsable(
			{ ...challenge, consumedAt: new Date(T0.getTime() - 10 * 60 * 1000 - 1) },
			{ purpose: "CLEAR", userEmail: "user@example.com" },
			T0,
		);
		expect(result).toEqual({ ok: false, code: "VERIFICATION_EXPIRED" });
	});

	it("purpose 不匹配拒绝（VERIFICATION_PURPOSE_MISMATCH）", () => {
		expect(
			verifyChallengeCredential(
				challenge,
				{ purpose: "DELETION", userEmail: "user@example.com" },
				T0,
			),
		).toEqual({ ok: false, code: "VERIFICATION_PURPOSE_MISMATCH" });
	});

	it("LOGIN 用途不放行数据操作（登录码不能顶用）", () => {
		expect(
			verifyChallengeCredential(
				{ ...challenge, purpose: "LOGIN" },
				{ purpose: "LOGIN", userEmail: "user@example.com" },
				T0,
			),
		).toEqual({ ok: false, code: "VERIFICATION_PURPOSE_MISMATCH" });
	});

	it("未消费的验证码不是凭证（VERIFICATION_INVALID）", () => {
		expect(
			verifyChallengeCredential(
				{ ...challenge, consumedAt: null },
				{ purpose: "CLEAR", userEmail: "user@example.com" },
				T0,
			),
		).toEqual({ ok: false, code: "VERIFICATION_INVALID" });
	});

	it("target 与当前用户邮箱不符拒绝（VERIFICATION_INVALID，大小写不敏感）", () => {
		expect(
			verifyChallengeCredential(
				challenge,
				{ purpose: "CLEAR", userEmail: "other@example.com" },
				T0,
			),
		).toEqual({ ok: false, code: "VERIFICATION_INVALID" });
		expect(
			verifyChallengeCredential(
				challenge,
				{ purpose: "CLEAR", userEmail: "USER@EXAMPLE.COM" },
				T0,
			),
		).toMatchObject({ ok: true });
	});

	it("邮箱为空的账号（注销后置空场景）一律拒绝", () => {
		expect(
			verifyChallengeCredential(
				challenge,
				{ purpose: "CLEAR", userEmail: null },
				T0,
			),
		).toEqual({ ok: false, code: "VERIFICATION_INVALID" });
	});
});
