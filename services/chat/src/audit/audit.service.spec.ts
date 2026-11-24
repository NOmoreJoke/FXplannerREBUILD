import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { AuditService } from "./audit.service";
import { PrismaService } from "../prisma/prisma.service";
import {
	assertParentChildSameOrg,
	ParentChildOrgMismatchError,
} from "../authorization/organization-scope";

/**
 * 审计服务与组织作用域测试（W16 必配）：
 * - 同事务审计写失败 → 业务写同事务回滚（零脏写入，§13.1）；
 * - recordStandalone 可独立落 DENIED 拒绝审计；
 * - listAuditLogs 分页与筛选（时间/成员/动作/结果）。
 */

const db = new PrismaClient();
const audit = new AuditService(db as unknown as PrismaService);

let organizationId: string;
let userId: string;

beforeAll(async () => {
	const user = await db.user.create({
		data: {
			email: `audit-svc-${Date.now()}@example.com`,
			passwordHash: "test-hash",
			name: "审计服务测试用户",
		},
	});
	userId = user.id;
	const org = await db.organization.create({
		data: { name: "审计服务测试组织" },
	});
	organizationId = org.id;
});

afterAll(async () => {
	await db.auditLog.deleteMany({ where: { organizationId } });
	await db.membership.deleteMany({ where: { organizationId } });
	await db.organization.delete({ where: { id: organizationId } }).catch(() => {});
	await db.user.delete({ where: { id: userId } }).catch(() => {});
	await db.$disconnect();
});

describe("AuditService：同事务原子性（§13.1）", () => {
	it("审计写失败 → 同事务业务写回滚，零脏写入", async () => {
		await expect(
			db.$transaction(async (tx) => {
				await tx.membership.create({
					data: {
						organizationId,
						userId,
						role: "OWNER",
						status: "ACTIVE",
					},
				});
				// 审计行缺 actorType（必填）→ 写入失败 → 整个事务回滚
				await audit.recordInTx(tx, {
					organizationId,
					actorUserId: userId,
					actorType: null as never,
					action: "test.atomic",
					result: "SUCCESS",
				});
			}),
		).rejects.toThrow();
		const membership = await db.membership.findFirst({
			where: { organizationId, userId },
		});
		expect(membership).toBeNull();
	});

	it("审计写成功 → 业务写与审计同事务提交", async () => {
		await db.$transaction(async (tx) => {
			await tx.membership.create({
				data: { organizationId, userId, role: "OWNER", status: "ACTIVE" },
			});
			await audit.recordInTx(tx, {
				organizationId,
				actorUserId: userId,
				actorType: "USER",
				action: "test.atomic.success",
				result: "SUCCESS",
				detail: { token: "敏感原文", planId: "p1" },
			});
		});
		const membership = await db.membership.findFirst({
			where: { organizationId, userId },
		});
		expect(membership).not.toBeNull();
		const log = await db.auditLog.findFirst({
			where: { organizationId, action: "test.atomic.success" },
		});
		expect(log).not.toBeNull();
		// detail 已脱敏：token 原文不落库
		expect((log?.detail as Record<string, unknown>).token).toBe("[REDACTED]");
	});
});

describe("AuditService：独立拒绝审计与只读分页", () => {
	it("recordStandalone 落 DENIED 行（纯读拒绝场景）", async () => {
		await audit.recordStandalone({
			organizationId,
			actorUserId: userId,
			actorType: "USER",
			action: "test.denied",
			targetType: "account",
			targetId: "acc-1",
			result: "DENIED",
			detail: { required: "audit.read" },
		});
		const denied = await db.auditLog.findFirst({
			where: { organizationId, action: "test.denied" },
		});
		expect(denied?.result).toBe("DENIED");
		expect(denied?.targetType).toBe("account");
	});

	it("分页与时间/成员/动作/结果筛选", async () => {
		for (let i = 0; i < 5; i += 1) {
			await audit.recordStandalone({
				organizationId,
				actorUserId: userId,
				actorType: "USER",
				action: i % 2 === 0 ? "test.page.even" : "test.page.odd",
				result: "SUCCESS",
			});
		}
		const page1 = await audit.listAuditLogs(organizationId, {
			page: 1,
			pageSize: 3,
			action: "test.page.even",
		});
		expect(page1.total).toBe(3);
		expect(page1.items).toHaveLength(3);
		expect(page1.items.every((item) => item.action === "test.page.even")).toBe(
			true,
		);
		const byActor = await audit.listAuditLogs(organizationId, {
			actorUserId: userId,
			pageSize: 100,
		});
		expect(byActor.total).toBeGreaterThanOrEqual(6);
		const byResult = await audit.listAuditLogs(organizationId, {
			result: "DENIED",
		});
		expect(byResult.items.every((item) => item.result === "DENIED")).toBe(true);
		// 时间筛选：仅取未来区间 → 空
		const future = await audit.listAuditLogs(organizationId, {
			from: new Date(Date.now() + 3_600_000).toISOString(),
		});
		expect(future.total).toBe(0);
	});

	it("R2-I04：服务层兜底——解析不出时间的筛选值 → 400，不进到 Prisma（500）", async () => {
		for (const field of ["from", "to"] as const) {
			await expect(
				audit.listAuditLogs(organizationId, {
					[field]: "2026-99-99T99:99:59Z",
				}),
			).rejects.toMatchObject({
				status: 400,
				response: { code: "INVALID_AUDIT_TIME" },
			});
		}
	});

	it("R3-I06：换算为 UTC 后年份越界的筛选值 → 400，不进到 Prisma（500）", async () => {
		// DTO 的形状正则只约束字面量是 4 位年份；带负时区的 9999 年末时刻换算后
		// UTC 年是 10000，Prisma 无法表示。DTO 两道校验都放行，只能在服务层拦
		for (const field of ["from", "to"] as const) {
			await expect(
				audit.listAuditLogs(organizationId, {
					[field]: "9999-12-31T23:59:59.999-01:00",
				}),
			).rejects.toMatchObject({
				status: 400,
				response: { code: "INVALID_AUDIT_TIME" },
			});
		}
		// 边界内的极值照常可用：UTC 年恰为 0001 与 9999
		const edges = await audit.listAuditLogs(organizationId, {
			from: "0001-01-01T00:00:00.000Z",
			to: "9999-12-31T23:59:59.999+01:00",
		});
		expect(edges.total).toBeGreaterThan(0);
	});
});

describe("AuditService：detail 永不阻断业务写（评审 R2-I04）", () => {
	const REDACTED = "[REDACTED]";
	/** 敏感键下的「凭据」占位值一律工厂生成（非真实凭据；与 audit-sanitizer.spec 同款） */
	const sample = (label: string): string => `sample-${label}`;

	it("含非 JSON 值 / 二进制视图 / __proto__ 键的 detail：脱敏后可被 Prisma 接受，业务写与审计同事务提交", async () => {
		const tokenSample = sample("token");
		await db.$transaction(async (tx) => {
			await tx.organization.update({
				where: { id: organizationId },
				data: { name: "审计服务测试组织（已改名）" },
			});
			const sensitive: Record<string, string> = {};
			sensitive["access" + "Token"] = tokenSample;
			await audit.recordInTx(tx, {
				organizationId,
				actorUserId: userId,
				actorType: "USER",
				action: "test.json-safety",
				result: "SUCCESS",
				detail: {
					notANumber: Number.NaN,
					infinite: Number.POSITIVE_INFINITY,
					fn: () => "leak",
					symbol: Symbol("leak"),
					// 仅拦 Buffer/Uint8Array 时会被 String(value) 以十进制明文串化
					bytes: new Int32Array([7, 5, 3]),
					hostile: JSON.parse(
						'{"__proto__":{"polluted":"yes"},"kept":1}',
					) as Record<string, unknown>,
					planId: "p1",
					...sensitive,
				},
			});
		});
		// 审计写不再因 JSONB 校验失败而回滚业务写
		expect(
			(await db.organization.findUniqueOrThrow({ where: { id: organizationId } }))
				.name,
		).toBe("审计服务测试组织（已改名）");

		const log = await db.auditLog.findFirstOrThrow({
			where: { organizationId, action: "test.json-safety" },
		});
		const detail = log.detail as Record<string, unknown>;
		expect(Object.keys(detail).sort()).toEqual(
			[
				"accessToken",
				"bytes",
				"fn",
				"hostile",
				"infinite",
				"notANumber",
				"planId",
				"symbol",
			].sort(),
		);
		expect(detail.notANumber).toBeNull();
		expect(detail.infinite).toBeNull();
		expect(detail.fn).toBeNull();
		expect(detail.symbol).toBeNull();
		expect(detail.bytes).toBe("[BINARY]");
		expect(detail.hostile).toEqual({ kept: 1 });
		expect(detail.planId).toBe("p1");
		expect(detail.accessToken).toBe(REDACTED);
		expect(JSON.stringify(log.detail)).not.toMatch(/leak|753|polluted|sample-token/);
	});
});

describe("organization-scope：父子一致断言", () => {
	it("一致通过；不一致抛 ParentChildOrgMismatchError", () => {
		expect(() =>
			assertParentChildSameOrg("org-a", "org-a"),
		).not.toThrow();
		expect(() => assertParentChildSameOrg("org-a", "org-b")).toThrowError(
			ParentChildOrgMismatchError,
		);
	});
});
