import { createRequire } from "node:module";
import path from "node:path";
import { readEnvFile } from "./env-local";
import { assertRateCacheTestDatabase } from "./rate-cache-db";

/**
 * E2E 数据请求 DB 钩子（account-data 技术方案 §10.4；W30 MIG-F 改用 requesterUserId）：
 * 「到期推进」场景直接写库 dueAt 过去时刻构造，不等待真实时间。
 * DATABASE_URL 取 services/chat/.env.local（E2E 进程不加载后端 env 链）。
 */
function resolveLocalDatabaseUrl(): string {
	const chatRoot = path.resolve(process.cwd(), "services/chat");
	const databaseUrl =
		process.env.DATABASE_URL ??
		readEnvFile(path.join(chatRoot, ".env.local")).DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("数据请求 E2E 需要连接候选后端使用的本地测试库");
	}
	const url = new URL(databaseUrl);
	if (
		(url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
		// Prisma 支持 ?host= 改写连接目标：主机名是回环也不算数
		url.searchParams.has("host")
	) {
		throw new Error("数据请求 E2E 仅允许本地回环主机上的 PostgreSQL 测试库");
	}
	assertRateCacheTestDatabase(decodeURIComponent(url.pathname.slice(1)));
	return databaseUrl;
}

/** 本文件用到的 PrismaClient 最小结构类型（e2e 不进任何 typecheck 任务） */
interface DataRequestDb {
	dataRequest: {
		update(args: {
			where: { id: string };
			data: { dueAt: Date };
		}): Promise<unknown>;
		findFirstOrThrow(args: {
			where: { requesterUserId: string };
			orderBy: { requestedAt: "desc" };
			select: { id: true };
		}): Promise<{ id: string }>;
		count(args: { where: { requesterUserId: string } }): Promise<number>;
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
	PrismaClient: new (options: { datasourceUrl: string }) => DataRequestDb;
};

let cachedPrisma: DataRequestDb | null = null;
function getTestPrisma(): DataRequestDb {
	if (!cachedPrisma) {
		cachedPrisma = new PrismaClient({ datasourceUrl: resolveLocalDatabaseUrl() });
	}
	return cachedPrisma;
}

/** 将请求 dueAt 置为过去（下一请求到达时读时惰性推进触发清理） */
export async function makeRequestDue(requestId: string): Promise<void> {
	await getTestPrisma().dataRequest.update({
		where: { id: requestId },
		data: { dueAt: new Date(Date.now() - 1000) },
	});
}

/** 按用户查最新请求 id（进度页断言/推进钩子用） */
export async function latestRequestId(userId: string): Promise<string> {
	const row = await getTestPrisma().dataRequest.findFirstOrThrow({
		where: { requesterUserId: userId },
		orderBy: { requestedAt: "desc" },
		select: { id: true },
	});
	return row.id;
}

/** 全量查当前用户数据请求行数（撤回/删除后断言） */
export async function requestCount(userId: string): Promise<number> {
	return getTestPrisma().dataRequest.count({ where: { requesterUserId: userId } });
}

export async function closeDb(): Promise<void> {
	if (cachedPrisma) {
		await cachedPrisma.$disconnect();
		cachedPrisma = null;
	}
}
