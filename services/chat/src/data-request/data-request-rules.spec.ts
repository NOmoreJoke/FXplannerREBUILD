import { describe, expect, it } from "vitest";
import { can } from "../authorization/permission-policy";
import {
	ACTIVE_STATUSES,
	assertCredentialUsable,
	computeDueAt,
	DATA_REQUEST_SCOPES,
	defaultScopeForType,
	isDataRequestScope,
	resolveAdvance,
	resolveAuditCleanupPolicy,
	resolveCancel,
	resolveCreationConflict,
	resolveDownload,
	resolveLastOwnerBlock,
	resolveOrganizationLock,
	resolvePersonalLock,
	resolveScopeType,
	requiredPermission,
	SCOPE_ALLOWED_TYPES,
	toDisplayStatus,
	verifyChallengeCredential,
	type AuditCleanupPolicy,
	type ExistingRequestLike,
	type OwnershipSnapshot,
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
		scope: "PERSONAL",
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

	it("组织域导出下载入口指向组织端点（物理拆分）", () => {
		expect(resolveDownload({ ...exportDone, scope: "ORGANIZATION" }, T0)).toEqual({
			url: "/api/organizations/current/data-requests/req-1/download",
			expiresAt: exportDone.downloadExpiresAt,
		});
	});
});

describe("data-request-rules 锁判定（双守卫拆分）", () => {
	it("个人锁：DELETION 三态全锁（ACCOUNT_PENDING_DELETION）", () => {
		for (const status of ["PENDING", "PROCESSING", "FAILED"]) {
			expect(resolvePersonalLock({ type: "DELETION", status })).toBe(
				"ACCOUNT_PENDING_DELETION",
			);
		}
	});

	it("个人锁：EXPORT 不锁业务（只读快照）", () => {
		for (const status of ["PENDING", "PROCESSING", "FAILED"]) {
			expect(resolvePersonalLock({ type: "EXPORT", status })).toBeNull();
		}
	});

	it("组织锁：CLEAR PROCESSING/FAILED 全锁（ORGANIZATION_DATA_LOCKED）", () => {
		for (const status of ["PROCESSING", "FAILED"]) {
			for (const method of ["GET", "POST"]) {
				expect(resolveOrganizationLock({ type: "CLEAR", status }, method)).toBe(
					"ORGANIZATION_DATA_LOCKED",
				);
			}
		}
	});

	it("组织锁：CLEAR PENDING 仅锁非 GET（停写不停看）", () => {
		expect(resolveOrganizationLock({ type: "CLEAR", status: "PENDING" }, "GET")).toBeNull();
		expect(resolveOrganizationLock({ type: "CLEAR", status: "PENDING" }, "POST")).toBe(
			"ORGANIZATION_DATA_LOCKED",
		);
		expect(resolveOrganizationLock({ type: "CLEAR", status: "PENDING" }, "patch")).toBe(
			"ORGANIZATION_DATA_LOCKED",
		);
	});

	it("组织锁：DELETION 进行中三态全端点拦截（含 GET）", () => {
		for (const status of ["PENDING", "PROCESSING", "FAILED"]) {
			expect(resolveOrganizationLock({ type: "DELETION", status }, "GET")).toBe(
				"ORGANIZATION_DATA_LOCKED",
			);
		}
	});

	it("无锁或终态放行", () => {
		expect(resolvePersonalLock(null)).toBeNull();
		expect(resolveOrganizationLock(null, "POST")).toBeNull();
		expect(resolvePersonalLock({ type: "DELETION", status: "COMPLETED" })).toBeNull();
		expect(resolveOrganizationLock({ type: "CLEAR", status: "CANCELLED" }, "POST")).toBeNull();
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

// ─────────────────────────────────────────────────────────────
// 双域拆分（技术方案 §9；Goal #3B W26）
// ─────────────────────────────────────────────────────────────

describe("data-request-rules scope × type 合法性矩阵（与 DB CHECK 同口径）", () => {
	const SCOPES = ["PERSONAL", "ORGANIZATION"] as const;
	const TYPES = ["EXPORT", "CLEAR", "DELETION"] as const;
	/** 唯一合法的 5 种组合 */
	const ALLOWED = new Set([
		"PERSONAL|EXPORT|null",
		"PERSONAL|DELETION|null",
		"ORGANIZATION|EXPORT|org",
		"ORGANIZATION|CLEAR|org",
		"ORGANIZATION|DELETION|org",
	]);

	it("穷举 2 scope × 3 type × 组织有无：恰好 5 种放行，其余逐项给出拒绝码", () => {
		const allowedSeen: string[] = [];
		for (const scope of SCOPES) {
			for (const type of TYPES) {
				for (const organizationId of [null, "org-1"]) {
					// 组织有无归一为 null / org 两态（与 ALLOWED 的键一致）
					const key = `${scope}|${type}|${organizationId === null ? "null" : "org"}`;
					const result = resolveScopeType({ scope, type, organizationId });
					if (ALLOWED.has(key)) {
						expect(result, key).toEqual({ ok: true });
						allowedSeen.push(key);
					} else if (scope === "ORGANIZATION" && organizationId === null) {
						expect(result, key).toEqual({
							ok: false,
							code: "ORGANIZATION_REQUIRED",
						});
					} else {
						expect(result, key).toEqual({
							ok: false,
							code: "SCOPE_TYPE_MISMATCH",
						});
					}
				}
			}
		}
		// 防同义反复：矩阵确有 5 格放行、7 格拒绝（12 = 5 + 7）
		expect(allowedSeen).toHaveLength(5);
		expect(SCOPES.length * TYPES.length * 2).toBe(12);
	});

	it("PERSONAL 不得清空组织账本（PERSONAL + CLEAR 一律拒绝），ORGANIZATION 不得缺组织", () => {
		expect(
			resolveScopeType({ scope: "PERSONAL", type: "CLEAR", organizationId: null }),
		).toEqual({ ok: false, code: "SCOPE_TYPE_MISMATCH" });
		expect(
			resolveScopeType({ scope: "PERSONAL", type: "DELETION", organizationId: "org-1" }),
		).toEqual({ ok: false, code: "SCOPE_TYPE_MISMATCH" });
		expect(
			resolveScopeType({ scope: "ORGANIZATION", type: "EXPORT", organizationId: null }),
		).toEqual({ ok: false, code: "ORGANIZATION_REQUIRED" });
	});

	it("未知 scope / 未知 type fail-closed", () => {
		expect(isDataRequestScope("personal")).toBe(false);
		expect(isDataRequestScope("TEAM")).toBe(false);
		expect(isDataRequestScope(undefined)).toBe(false);
		expect(isDataRequestScope("ORGANIZATION")).toBe(true);
		expect(
			resolveScopeType({ scope: "TEAM", type: "EXPORT", organizationId: "org-1" }),
		).toEqual({ ok: false, code: "SCOPE_TYPE_MISMATCH" });
		expect(
			resolveScopeType({ scope: "ORGANIZATION", type: "PURGE", organizationId: "org-1" }),
		).toEqual({ ok: false, code: "SCOPE_TYPE_MISMATCH" });
	});

	it("未显式指定 scope：清空 = 默认组织的 ORGANIZATION，导出/注销 = PERSONAL（§9.2）", () => {
		expect(defaultScopeForType("CLEAR")).toBe("ORGANIZATION");
		expect(defaultScopeForType("EXPORT")).toBe("PERSONAL");
		expect(defaultScopeForType("DELETION")).toBe("PERSONAL");
		for (const type of TYPES) {
			// 默认归属与「组织有无」自洽：默认 scope 下该 type 必在允许集合内
			const scope = defaultScopeForType(type);
			expect(SCOPE_ALLOWED_TYPES[scope], type).toContain(type);
		}
	});

	it("组织域所需权限点与 DATA-01 角色矩阵一致（个人域不涉及角色）", () => {
		expect(requiredPermission("PERSONAL", "EXPORT")).toBeNull();
		expect(requiredPermission("PERSONAL", "DELETION")).toBeNull();
		expect(requiredPermission("ORGANIZATION", "EXPORT")).toBe("data.export");
		expect(requiredPermission("ORGANIZATION", "CLEAR")).toBe("data.clear");
		expect(requiredPermission("ORGANIZATION", "DELETION")).toBe("organization.delete");

		// 需求 DATA-01：导出 Owner/Admin/Finance；清空 Owner/Admin；删除仅 Owner
		const expectGranted = (
			role: Parameters<typeof can>[0],
			type: (typeof TYPES)[number],
			granted: boolean,
		) => {
			const permission = requiredPermission("ORGANIZATION", type);
			if (!permission) throw new Error("组织域请求必须有权限点");
			expect(can(role, permission), `${role} × ${type}`).toBe(granted);
		};
		for (const type of TYPES) {
			expectGranted("OWNER", type, true);
			expectGranted("VIEWER", type, false);
			expectGranted("OPERATOR", type, false);
		}
		expectGranted("ADMIN", "EXPORT", true);
		expectGranted("ADMIN", "CLEAR", true);
		expectGranted("ADMIN", "DELETION", false);
		expectGranted("FINANCE", "EXPORT", true);
		expectGranted("FINANCE", "CLEAR", false);
		expectGranted("FINANCE", "DELETION", false);
	});
});

describe("data-request-rules 双域锁语义（技术方案 §9.1–§9.3 锁范围）", () => {
	const METHODS = ["GET", "POST", "PATCH", "DELETE", "get"];
	const ACTIVE = ["PENDING", "PROCESSING", "FAILED"] as const;
	const TERMINAL = ["COMPLETED", "CANCELLED"] as const;

	it("导出不锁写：PERSONAL / ORGANIZATION EXPORT 在任何状态、任何方法下都放行", () => {
		for (const status of [...ACTIVE, ...TERMINAL]) {
			for (const method of METHODS) {
				expect(resolvePersonalLock({ type: "EXPORT", status }), `PERSONAL ${status} ${method}`).toBeNull();
				expect(
					resolveOrganizationLock({ type: "EXPORT", status }, method),
					`ORGANIZATION ${status} ${method}`,
				).toBeNull();
			}
		}
	});

	it("PERSONAL DELETION 锁个人账号：进行中三态全端点拦截（含 GET）", () => {
		for (const status of ACTIVE) {
			expect(resolvePersonalLock({ type: "DELETION", status })).toBe(
				"ACCOUNT_PENDING_DELETION",
			);
		}
	});

	it("ORGANIZATION CLEAR 锁组织写：冷静期仅拦非 GET，处理中/失败全拦", () => {
		for (const status of ["PROCESSING", "FAILED"] as const) {
			for (const method of METHODS) {
				expect(resolveOrganizationLock({ type: "CLEAR", status }, method)).toBe(
					"ORGANIZATION_DATA_LOCKED",
				);
			}
		}
		expect(resolveOrganizationLock({ type: "CLEAR", status: "PENDING" }, "GET")).toBeNull();
		for (const method of ["POST", "PATCH", "DELETE", "get"]) {
			// 小写 get 仍视为读（大小写无关口径）
			expect(resolveOrganizationLock({ type: "CLEAR", status: "PENDING" }, method)).toBe(
				method === "get" ? null : "ORGANIZATION_DATA_LOCKED",
			);
		}
	});

	it("ORGANIZATION DELETION 锁组织写：进行中三态全端点拦截（含 GET）", () => {
		for (const status of ACTIVE) {
			for (const method of METHODS) {
				expect(resolveOrganizationLock({ type: "DELETION", status }, method)).toBe(
					"ORGANIZATION_DATA_LOCKED",
				);
			}
		}
	});

	it("组织锁不会冒充个人账号注销：ORGANIZATION DELETION 永不返回 ACCOUNT_PENDING_DELETION", () => {
		for (const status of ACTIVE) {
			expect(resolveOrganizationLock({ type: "DELETION", status }, "GET")).not.toBe(
				"ACCOUNT_PENDING_DELETION",
			);
		}
	});

	it("个人锁不会冒充组织锁：PERSONAL DELETION 永不返回 ORGANIZATION_DATA_LOCKED", () => {
		for (const status of ACTIVE) {
			expect(resolvePersonalLock({ type: "DELETION", status })).not.toBe(
				"ORGANIZATION_DATA_LOCKED",
			);
		}
	});

	it("未知类型 fail-closed 上锁（库内出现未预期组合时不得放行）", () => {
		for (const method of METHODS) {
			expect(resolvePersonalLock({ type: "WEIRD", status: "PENDING" })).toBe(
				"ACCOUNT_PENDING_DELETION",
			);
			expect(resolveOrganizationLock({ type: "WEIRD", status: "PENDING" }, method)).toBe(
				"ORGANIZATION_DATA_LOCKED",
			);
		}
	});

	it("终态放行（任一数据域）", () => {
		for (const status of TERMINAL) {
			expect(resolvePersonalLock({ type: "DELETION", status })).toBeNull();
			expect(resolveOrganizationLock({ type: "DELETION", status }, "POST")).toBeNull();
			expect(resolveOrganizationLock({ type: "CLEAR", status }, "POST")).toBeNull();
		}
	});
});

describe("data-request-rules 最后 Owner 阻塞判定（DATA-02.4 / 验收 27）", () => {
	function entry(
		patch: Partial<OwnershipSnapshot> = {},
	): OwnershipSnapshot {
		return {
			organizationId: "org-a",
			organizationName: "A 的工作台",
			membership: { role: "OWNER", status: "ACTIVE" },
			otherActiveOwnerCount: 0,
			hasSharedRows: false,
			...patch,
		};
	}

	it("本人是唯一 ACTIVE OWNER → 阻塞并给出组织名与角色", () => {
		expect(resolveLastOwnerBlock([entry()])).toEqual([
			{ organizationId: "org-a", organizationName: "A 的工作台", role: "OWNER" },
		]);
	});

	it("ACTIVE OWNER 但另有 ACTIVE OWNER → 放行（可把共享行过户给对方）", () => {
		expect(resolveLastOwnerBlock([entry({ otherActiveOwnerCount: 1 })])).toEqual([]);
		expect(resolveLastOwnerBlock([entry({ otherActiveOwnerCount: 3 })])).toEqual([]);
	});

	it("已转移所有权（ADMIN）或已被移除（DISABLED）的成员不阻塞", () => {
		// 组织仍有另一名 ACTIVE OWNER（单活跃 Owner 不变量下非 Owner 成员存在的前提）
		expect(
			resolveLastOwnerBlock([
				entry({
					membership: { role: "ADMIN", status: "ACTIVE" },
					otherActiveOwnerCount: 1,
					hasSharedRows: true,
				}),
			]),
		).toEqual([]);
		expect(
			resolveLastOwnerBlock([
				entry({
					membership: { role: "OWNER", status: "DISABLED" },
					otherActiveOwnerCount: 1,
					hasSharedRows: true,
				}),
			]),
		).toEqual([]);
	});

	it("持有共享行却无人可接任 → 阻塞（无处过户，不静默删共享账本）", () => {
		expect(
			resolveLastOwnerBlock([
				entry({
					organizationId: "org-x",
					organizationName: "无主组织",
					membership: { role: "FINANCE", status: "ACTIVE" },
					hasSharedRows: true,
				}),
			]),
		).toEqual([
			{ organizationId: "org-x", organizationName: "无主组织", role: "FINANCE" },
		]);
		// 成员关系已不存在（异常态）同理阻塞，角色记 NONE
		expect(
			resolveLastOwnerBlock([entry({ membership: null, hasSharedRows: true })]),
		).toEqual([
			{ organizationId: "org-a", organizationName: "A 的工作台", role: "NONE" },
		]);
		// 无成员关系且无共享行 → 与该组织再无瓜葛，不阻塞
		expect(resolveLastOwnerBlock([entry({ membership: null })])).toEqual([]);
	});

	it("多个组织：列出全部阻塞组织，不替用户选择处置方式", () => {
		const blocking = resolveLastOwnerBlock([
			entry({ organizationId: "org-a", organizationName: "A", otherActiveOwnerCount: 1 }),
			entry({ organizationId: "org-b", organizationName: "B" }),
			entry({
				organizationId: "org-c",
				organizationName: "C",
				membership: { role: "VIEWER", status: "ACTIVE" },
				hasSharedRows: true,
			}),
			entry({ organizationId: "org-d", organizationName: "D" }),
		]);
		expect(blocking).toEqual([
			{ organizationId: "org-b", organizationName: "B", role: "OWNER" },
			{ organizationId: "org-c", organizationName: "C", role: "VIEWER" },
			{ organizationId: "org-d", organizationName: "D", role: "OWNER" },
		]);
	});

	it("无任何组织（纯个人账号）不阻塞", () => {
		expect(resolveLastOwnerBlock([])).toEqual([]);
	});
});

describe("data-request-rules 审计清理策略", () => {
	it("穷举 6 种组合：仅组织删除在删组织前清理审计", () => {
		const expected: Record<string, AuditCleanupPolicy> = {
			"PERSONAL|EXPORT": "KEEP",
			"PERSONAL|DELETION": "KEEP",
			"ORGANIZATION|EXPORT": "KEEP",
			"ORGANIZATION|CLEAR": "KEEP",
			"ORGANIZATION|DELETION": "PURGE_BEFORE_ORG_DELETE",
		};
		for (const scope of DATA_REQUEST_SCOPES) {
			for (const type of ["EXPORT", "CLEAR", "DELETION"] as const) {
				if (scope === "PERSONAL" && type === "CLEAR") continue; // 不合法组合
				expect(resolveAuditCleanupPolicy(scope, type), `${scope}|${type}`).toBe(
					expected[`${scope}|${type}`],
				);
			}
		}
		// 个人注销不删组织审计（DATA-01 语义分离）
		expect(resolveAuditCleanupPolicy("PERSONAL", "DELETION")).toBe("KEEP");
	});
});
