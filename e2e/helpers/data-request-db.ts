import { createRequire } from "module";
import path from "path";
import { readEnvFile } from "./env-local";

/**
 * E2E 数据请求 DB 钩子（account-data 技术方案 §10.4）：
 * 「到期推进」场景直接写库 dueAt 过去时刻构造，不等待真实时间。
 * DATABASE_URL 取 services/chat/.env.local（E2E 进程不加载后端 env 链）。
 */
process.env.DATABASE_URL ??= readEnvFile(
	path.resolve(process.cwd(), "services/chat/.env.local"),
).DATABASE_URL;

/** 本文件用到的 PrismaClient 最小结构类型（e2e 不进任何 typecheck 任务） */
interface DataRequestDb {
	dataRequest: {
		update(args: {
			where: { id: string };
			data: { dueAt: Date };
		}): Promise<unknown>;
		findFirstOrThrow(args: {
			where: { userId: string };
			orderBy: { requestedAt: "desc" };
			select: { id: true };
		}): Promise<{ id: string }>;
		count(args: { where: { userId: string } }): Promise<number>;
	};
	$disconnect(): Promise<void>;
}

// Bun isolated linker 下 e2e/ 非 workspace 成员、根目录未声明 @prisma/client，
// 直接 import 无法解析；经 createRequire 锚定 services/chat 的 package.json，
// 从其依赖闭包解析「已按本仓库 schema 生成」的 PrismaClient。
const chatRequire = createRequire(
	path.resolve(process.cwd(), "services/chat/package.json"),
);
const { PrismaClient } = chatRequire("@prisma/client") as {
	PrismaClient: new () => DataRequestDb;
};

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
