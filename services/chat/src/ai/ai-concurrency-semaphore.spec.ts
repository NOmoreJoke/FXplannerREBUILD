import { describe, expect, it } from "vitest";
import { ConcurrencySemaphore } from "./ai-concurrency-semaphore";

/**
 * 信号量单测（ai-assistant 技术方案 §8.1）：
 * 并发上限拒绝、释放后可再取、异常路径必释放。
 */
describe("ConcurrencySemaphore", () => {
	it("并发上限拒绝：超过 limit 的 acquire 返回 false（快速失败不排队）", () => {
		const semaphore = new ConcurrencySemaphore(2);

		expect(semaphore.tryAcquire()).toBe(true);
		expect(semaphore.tryAcquire()).toBe(true);
		expect(semaphore.tryAcquire()).toBe(false);
		expect(semaphore.activeCount).toBe(2);
	});

	it("释放后可再取：release 归还槽位，后续 acquire 成功", () => {
		const semaphore = new ConcurrencySemaphore(1);

		expect(semaphore.tryAcquire()).toBe(true);
		expect(semaphore.tryAcquire()).toBe(false);

		semaphore.release();
		expect(semaphore.tryAcquire()).toBe(true);
		expect(semaphore.activeCount).toBe(1);
	});

	it("异常路径必释放：占用方抛错经 finally 释放后，槽位可被再次获取", async () => {
		const semaphore = new ConcurrencySemaphore(1);
		semaphore.tryAcquire();

		const failing = async (): Promise<void> => {
			try {
				throw new Error("boom");
			} finally {
				semaphore.release();
			}
		};
		await expect(failing()).rejects.toThrow("boom");

		// 异常释放后槽位可复用，且不越过 0（release 幂等下界）
		semaphore.release();
		expect(semaphore.activeCount).toBe(0);
		expect(semaphore.tryAcquire()).toBe(true);
	});

	it("limit=1 的独立实例互不影响（对应集成测试 AI_BUSY 场景的实例隔离）", () => {
		const a = new ConcurrencySemaphore(1);
		const b = new ConcurrencySemaphore(1);

		expect(a.tryAcquire()).toBe(true);
		expect(b.tryAcquire()).toBe(true);
		expect(a.tryAcquire()).toBe(false);
	});
});
