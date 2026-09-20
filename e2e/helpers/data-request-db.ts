import { config as dotenvConfig } from "dotenv";
import path from "path";
import { PrismaClient } from "@prisma/client";

/**
 * E2E 数据请求 DB 钩子（account-data 技术方案 §10.4）：
 * 「到期推进」场景直接写库 dueAt 过去时刻构造，不等待真实时间。
 * DATABASE_URL 取 services/chat/.env.local（E2E 进程不加载后端 env 链）。
 */

dotenvConfig({
	path: path.resolve(process.cwd(), "services/chat/.env.local"),
});

const testPrisma = new PrismaClient();

/** 将请求 dueAt 置为过去（下一请求到达时读时惰性推进触发清理） */
export async function makeRequestDue(requestId: string): Promise<void> {
	await testPrisma.dataRequest.update({
		where: { id: requestId },
		data: { dueAt: new Date(Date.now() - 1000) },
	});
}

/** 按用户查最新请求 id（进度页断言/推进钩子用） */
export async function latestRequestId(userId: string): Promise<string> {
	const row = await testPrisma.dataRequest.findFirstOrThrow({
		where: { userId },
		orderBy: { requestedAt: "desc" },
		select: { id: true },
	});
	return row.id;
}

/** 全量查当前用户数据请求行数（撤回/删除后断言） */
export async function requestCount(userId: string): Promise<number> {
	return testPrisma.dataRequest.count({ where: { userId } });
}

export async function closeDb(): Promise<void> {
	await testPrisma.$disconnect();
}
