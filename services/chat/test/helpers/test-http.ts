import type { INestApplication } from "@nestjs/common";

/** 让 Nest 持有监听器，避免 Supertest 临时监听后通过 IPv4 命中其他本机服务。 */
export async function listenOnTestLoopback(app: INestApplication): Promise<void> {
	try {
		await app.listen(0, "127.0.0.1");
	} catch (error) {
		await app.close().catch(() => {});
		throw error;
	}
}

/** 等每个应用都完成关闭，再报告关闭错误。 */
export async function closeTestApps(
	...apps: (INestApplication | undefined)[]
): Promise<void> {
	const results = await Promise.allSettled(apps.map((app) => app?.close()));
	const failures = results.filter((result) => result.status === "rejected");
	if (failures.length > 0) {
		throw new AggregateError(
			failures.map((failure) => failure.reason),
			"关闭测试应用失败",
		);
	}
}
