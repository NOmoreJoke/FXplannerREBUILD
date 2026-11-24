import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { lockOrganizationForActor } from "./default-organization";
import {
	OrganizationNotFoundException,
	PermissionDeniedException,
} from "../authorization/authorization.errors";

/**
 * 持锁写路径的操作者锁内重读（评审 R2-I01）。
 *
 * 被测函数只有 IO 边界（取锁 + 读操作者成员行），用假 tx 固定返回值，
 * 断言「先取锁后读行」的顺序与拒绝口径；真实并发下的端到端复现见
 * test/api/membership.spec.ts 的 R2-I01 用例（advisory 锁屏障）。
 */

type MembershipRow = {
	organizationId: string;
	role: string;
	status: string;
};

/** 假事务：记录取锁与读成员行的调用顺序，成员行返回值由用例指定 */
function makeTx(row: MembershipRow | null) {
	const executeRaw = vi.fn(async () => 1);
	const findUnique = vi.fn(async () => row);
	const tx = {
		$executeRaw: executeRaw,
		membership: { findUnique },
	} as unknown as Prisma.TransactionClient;
	return { tx, executeRaw, findUnique };
}

const ORG_ID = "caaaaaaaaaaaaaaaaaaaaaaaa";
const MEMBERSHIP_ID = "cbbbbbbbbbbbbbbbbbbbbbbb";
const actor = { organizationId: ORG_ID, membershipId: MEMBERSHIP_ID };

describe("lockOrganizationForActor（R2-I01 锁内重读操作者）", () => {
	it("先取组织锁、后读操作者行；锁键与成员行均按 actor 定位", async () => {
		const { tx, executeRaw, findUnique } = makeTx({
			organizationId: ORG_ID,
			role: "VIEWER",
			status: "ACTIVE",
		});
		await lockOrganizationForActor(tx, actor);

		expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
			findUnique.mock.invocationCallOrder[0]!,
		);
		// tagged template：[模板字符串数组, ...插值]
		expect(executeRaw.mock.calls[0]).toContain(`membership:${ORG_ID}`);
		expect(findUnique).toHaveBeenCalledWith({
			where: { id: MEMBERSHIP_ID },
			select: { organizationId: true, role: true, status: true },
		});
	});

	it("返回库内最新角色，而非调用方传入上下文里的旧角色", async () => {
		const { tx } = makeTx({
			organizationId: ORG_ID,
			role: "ADMIN",
			status: "ACTIVE",
		});
		await expect(lockOrganizationForActor(tx, actor)).resolves.toBe("ADMIN");
	});

	it("五角色枚举内均原样返回", async () => {
		for (const role of ["OWNER", "ADMIN", "FINANCE", "OPERATOR", "VIEWER"]) {
			const { tx } = makeTx({ organizationId: ORG_ID, role, status: "ACTIVE" });
			await expect(lockOrganizationForActor(tx, actor), role).resolves.toBe(
				role,
			);
		}
	});

	it("等待锁期间被移除（DISABLED）→ 404 ORGANIZATION_NOT_FOUND，与 Guard 口径一致", async () => {
		const { tx } = makeTx({
			organizationId: ORG_ID,
			role: "ADMIN",
			status: "DISABLED",
		});
		const error = await lockOrganizationForActor(tx, actor).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OrganizationNotFoundException);
		expect((error as OrganizationNotFoundException).getStatus()).toBe(404);
		expect(
			(error as OrganizationNotFoundException).getResponse(),
		).toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
	});

	it("成员行已不存在 → 404 ORGANIZATION_NOT_FOUND", async () => {
		const { tx } = makeTx(null);
		await expect(lockOrganizationForActor(tx, actor)).rejects.toBeInstanceOf(
			OrganizationNotFoundException,
		);
	});

	it("成员行属于其他组织（organizationId 不一致）→ 404", async () => {
		const { tx } = makeTx({
			organizationId: "cccccccccccccccccccccccc",
			role: "OWNER",
			status: "ACTIVE",
		});
		await expect(lockOrganizationForActor(tx, actor)).rejects.toBeInstanceOf(
			OrganizationNotFoundException,
		);
	});

	it("库内角色值非法 → 403 PERMISSION_DENIED（fail-closed，不放行未知角色）", async () => {
		for (const role of ["SUPERUSER", "admin", "", "MEMBER"]) {
			const { tx } = makeTx({ organizationId: ORG_ID, role, status: "ACTIVE" });
			const error = await lockOrganizationForActor(tx, actor).catch(
				(e: unknown) => e,
			);
			expect(error, role).toBeInstanceOf(PermissionDeniedException);
			expect((error as PermissionDeniedException).getStatus(), role).toBe(403);
			expect(
				(error as PermissionDeniedException).getResponse(),
				role,
			).toMatchObject({ code: "PERMISSION_DENIED" });
		}
	});
});
