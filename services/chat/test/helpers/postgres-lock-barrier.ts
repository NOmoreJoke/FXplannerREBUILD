import type { Prisma, PrismaClient } from "@prisma/client";
import type { Response } from "supertest";
import { expect } from "vitest";

async function waitForBlockedQueries(
	tx: Prisma.TransactionClient,
	blockerPid: number,
	queryPattern: string,
	count: number,
): Promise<number[]> {
	let waiterPids: number[] = [];
	await expect.poll(async () => {
		await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
		const waiters = await tx.$queryRaw<Array<{ pid: number }>>`
			SELECT pid FROM pg_stat_activity
			WHERE datname = current_database()
				AND wait_event_type = 'Lock'
				AND ${blockerPid} = ANY(pg_blocking_pids(pid))
				AND ltrim(query, chr(9) || chr(10) || chr(13) || ' ') LIKE ${queryPattern}`;
		waiterPids = waiters.map((waiter) => waiter.pid);
		return waiterPids.length;
	}, { timeout: 1800, message: `Expected ${count} PostgreSQL lock wait(s) for ${queryPattern}` })
		.toBeGreaterThanOrEqual(count);
	return waiterPids;
}

/** 等到一条查询被 blockerPid 阻塞，返回该查询的后端 pid（可作下一轮的阻塞者） */
function waitForBlockedQuery(
	tx: Prisma.TransactionClient,
	blockerPid: number,
	queryPattern: string,
): Promise<number> {
	return waitForBlockedQueries(tx, blockerPid, queryPattern, 1).then(
		([waiterPid]) => waiterPid!,
	);
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

/**
 * 屏障持锁期间依次发起 targets，待全部阻塞在锁上后执行 whileHeld，提交放行。
 * 返回值与 targets 同序；任一步失败即回滚屏障并收完全部响应后抛出。
 *
 * 顺序纪律（评审 R2-I06）：**屏障先持锁，再发起 target**。若先发请求后取锁，
 * 抖动下请求可能在屏障取锁前就已跑完，既复现不了竞态，waitForBlockedQueries
 * 也会等不到阻塞而超时。先持锁同时保证：请求的 Guard 读取发生在持锁期间
 * （读到的是并发改动之前的状态并通过鉴权），随后必然阻塞在锁上。
 */
async function behindAdvisoryLock<T>(
	prisma: PrismaClient,
	lockKey: string,
	targets: Array<() => Promise<T>>,
	whileHeld: () => Promise<void> = async () => {},
): Promise<T[]> {
	const pending: Promise<T>[] = [];
	try {
		await prisma.$transaction(
			async (tx) => {
				const [holder] = await tx.$queryRaw<Array<{ pid: number }>>`
					SELECT pg_backend_pid() AS pid
					FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
				expect(holder).toBeDefined();
				// 屏障已持锁：此刻才发起被测请求，并立即挂上拒绝处理
				//（屏障检查期间即处理，实际错误由返回的 promise 传回测试）
				for (const target of targets) {
					const response = target();
					pending.push(response);
					void response.catch(() => {});
				}
				await waitForBlockedQueries(
					tx,
					holder.pid,
					"SELECT pg_advisory_xact_lock(%",
					targets.length,
				);
				await whileHeld();
			},
			{ timeout: 10_000 },
		);
	} catch (error) {
		await Promise.allSettled(pending);
		throw error;
	}
	return Promise.all(pending);
}

/**
 * 持有事务级 advisory 锁（lockKey 与被测服务同一把），直到 target 发出的请求
 * 确实阻塞在这把锁上；阻塞期间执行 whileHeld（模拟「另一条不受该锁约束的写」，
 * 如直改数据库），随后提交屏障释放锁，让 target 继续并返回其结果。
 *
 * 用于确定性复现「读后写」竞态：被测请求必须持锁后才读状态——若它在锁外
 * 已读过状态（TOCTOU），并发改动会被漏判。whileHeld 抛错时屏障回滚并收完响应。
 */
export async function runBehindAdvisoryLock<T>(
	prisma: PrismaClient,
	lockKey: string,
	target: () => Promise<T>,
	whileHeld: () => Promise<void>,
): Promise<T> {
	const [result] = await behindAdvisoryLock(
		prisma,
		lockKey,
		[target],
		whileHeld,
	);
	return result!;
}

/**
 * 组织锁上的确定性并发竞争（评审 R2-I06）：屏障持锁后同时发起全部 targets，
 * 确认每一个都已通过 Guard 并阻塞在同一把锁上，再放行让它们竞争。
 *
 * 裸 Promise.all 下请求 2 可能在请求 1 提交之后才进 Guard，于是被合法地拒为
 * 403 PERMISSION_DENIED 而非进入锁内竞争；本函数保证全部请求都以「进入锁之前」
 * 的鉴权结果参与竞争，败方结果只取决于锁内的条件更新。返回值与 targets 同序。
 */
export async function raceBehindAdvisoryLock<T>(
	prisma: PrismaClient,
	lockKey: string,
	targets: Array<() => Promise<T>>,
): Promise<T[]> {
	return behindAdvisoryLock(prisma, lockKey, targets);
}
