/**
 * 进程内并发信号量（ai-assistant 技术方案 §2 辅助决策：自写 ~20 行，不为此引 p-limit）。
 *
 * 语义为「满即拒绝、不排队」：高峰溢出直接 429 AI_BUSY 快速失败（§1.2），
 * 宁可拒掉也不能堆积——acquire 失败不等待，调用方立即得到 false。
 * 单实例部署假设；未来水平扩容需外移（方案 §1.3 标注，本期不做）。
 */
export class ConcurrencySemaphore {
	private active = 0;

	constructor(private readonly limit: number) {}

	/** 尝试占用一个槽位；已满返回 false（快速失败），成功返回 true（须配对 release） */
	tryAcquire(): boolean {
		if (this.active >= this.limit) return false;
		this.active += 1;
		return true;
	}

	/** 释放一个槽位（幂等下界保护：不越过 0） */
	release(): void {
		this.active = Math.max(0, this.active - 1);
	}

	/** 当前占用数（测试与可观测性用） */
	get activeCount(): number {
		return this.active;
	}
}
