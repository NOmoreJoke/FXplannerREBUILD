import type { Prisma, PrismaClient } from "@prisma/client";
import type { Response } from "supertest";
import { expect } from "vitest";

async function waitForBlockedQuery(
	tx: Prisma.TransactionClient,
	blockerPid: number,
	queryPattern: string,
): Promise<number> {
	let waiterPid = 0;
	await expect.poll(async () => {
		await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
		const [waiter] = await tx.$queryRaw<Array<{ pid: number }>>`
			SELECT pid FROM pg_stat_activity
			WHERE datname = current_database()
				AND wait_event_type = 'Lock'
				AND ${blockerPid} = ANY(pg_blocking_pids(pid))
				AND ltrim(query, chr(9) || chr(10) || chr(13) || ' ') LIKE ${queryPattern}`;
		waiterPid = waiter?.pid ?? 0;
		return waiterPid;
	}, { timeout: 1800, message: `Expected PostgreSQL lock wait for ${queryPattern}` })
		.toBeGreaterThan(0);
	return waiterPid;
}

/**
 * 暂扣分配行，使首请求完成业务读取、进入写入后等锁，再发出次请求。
 * 观察到次请求由首请求阻塞后才提交屏障事务。异常时也会回滚屏障并收完 HTTP 响应。
 */
export async function orderLedgerRequests(
	prisma: PrismaClient,
	planId: string,
	first: () => Promise<Response>,
	second: () => Promise<Response>,
): Promise<Response[]> {
	const pending: Promise<Response>[] = [];
	function start(send: () => Promise<Response>) {
		const response = send();
		pending.push(response);
		// 屏障检查期间即处理拒绝。实际错误由 Promise.all 传回测试。
		void response.catch(() => {});
	}

	try {
		await prisma.$transaction(async (tx) => {
			const [holder] = await tx.$queryRaw<Array<{ pid: number }>>`
				SELECT pg_backend_pid() AS pid FROM plan_allocations
				WHERE plan_id = ${planId} FOR UPDATE`;
			expect(holder).toBeDefined();
			start(first);
			const firstPid = await waitForBlockedQuery(
				tx, holder.pid, "UPDATE%plan_allocations%",
			);
			start(second);
			await waitForBlockedQuery(tx, firstPid, "SELECT pg_advisory_xact_lock(%");
		});
		return await Promise.all(pending);
	} finally {
		await Promise.allSettled(pending);
	}
}
