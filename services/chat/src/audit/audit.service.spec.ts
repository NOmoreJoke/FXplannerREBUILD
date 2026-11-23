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
