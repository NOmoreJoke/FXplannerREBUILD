import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readEnvFile } from "./env-local";

/**
 * E2E 汇率缓存兜底钩子（报告模块 T-RPT 造数；仅本地测试库）。
 *
 * 外呼实时汇率受本机代理 / TUN 影响时不稳定：POST /api/onboarding/initial-holdings 取价失败
 * 会报 400 RATE_UNAVAILABLE，拖垮整个 describe 的 beforeAll。本钩子在本地测试库为指定币种
 * 插入一条「刚确认」的 frankfurter 缓存行，让入账取价命中新鲜缓存、不再外呼。
 *
 * 插入行与 RateService.persistQuote 的回源写入同形，满足 findLatestPublishableQuotes 的
 * 已确认层条件：latest_confirmed_at = now（入账取价 5 分钟有效窗口的基准）+
 * canonical_write_id = 新 UUID（回源方向标记，可信方向条件之一）。调用方必须在重试返回后
 * 按 id 清理，避免这条合成报价被同币种的其他入账取价选中。
 */

/** 兜底注入的测试汇率缓存行（调用方按 id 清理） */
export interface InjectedRateRow {
	id: string;
	base: string;
	quote: string;
}

/** 本文件用到的 PrismaClient 最小结构类型（e2e 不进任何 typecheck 任务） */
interface RateCacheDb {
	exchangeRate: {
		create(args: {
			data: {
				base: string;
				quote: string;
				rate: string;
				source: string;
				observedAt: Date;
				latestConfirmedAt: Date;
				canonicalWriteId: string;
			};
			select: { id: true };
		}): Promise<{ id: string }>;
		deleteMany(args: {
			where: { id: { in: string[] } };
		}): Promise<unknown>;
	};
	$disconnect(): Promise<void>;
}

/**
 * 会写全局报价表 exchange_rates 的 E2E 的库名闸门（报价更正 T-CORR-005 与本文件的兜底共用）。
 * 回环主机校验由调用方在同函数内完成，这里只管库名：
 * - 显式指定 FXPLANNER_E2E_QUOTE_DATABASE（run-e2e-tests.sh 从 DATABASE_URL 解析库名后注入）
 *   时必须与实际库相等；
 * - 未显式指定（人类单独 bunx playwright test，没有脚本注入）时，库名以 _local / _test
 *   结尾即放行；其余一律拒绝。空串按未设置处理（与脚本 ${VAR:-…} 同口径）。
 */
export function assertRateCacheTestDatabase(database: string): void {
	const expectedDatabase =
		process.env.FXPLANNER_E2E_QUOTE_DATABASE || undefined;
	const isLocalTestDatabase = /_(local|test)$/.test(database);
	if (
		!database ||
		(expectedDatabase !== undefined && expectedDatabase !== database) ||
		(expectedDatabase === undefined && !isLocalTestDatabase)
	) {
		throw new Error(
			`会写全局报价表的 E2E 仅允许候选专用测试库（当前库：${database || "（空）"}）。` +
				"请用 FXPLANNER_E2E_QUOTE_DATABASE 指定候选专用测试库，或使用以 _local / _test 结尾的本地测试库。",
		);
	}
}

/**
 * 连接候选后端使用的本地测试库执行 run：DATABASE_URL 取 services/chat/.env.local
 * （E2E 进程不加载后端 env 链），仅允许回环主机上的 PostgreSQL，用完即断开。
 * 回环校验与 new PrismaClient 留在同一函数内（VERIFY.md：请求 helper 同函数回环校验）。
 */
async function withLocalTestDatabase<T>(
	run: (prisma: RateCacheDb) => Promise<T>,
): Promise<T> {
	const chatRoot = path.resolve(process.cwd(), "services/chat");
	const databaseUrl =
		process.env.DATABASE_URL ??
		readEnvFile(path.join(chatRoot, ".env.local")).DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("汇率缓存兜底需要连接候选后端使用的本地测试库");
	}
	const url = new URL(databaseUrl);
	if (
		(url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
		// Prisma 支持 ?host= 改写连接目标：主机名是回环也不算数
		url.searchParams.has("host")
	) {
		throw new Error("汇率缓存兜底仅允许本地回环主机上的 PostgreSQL 测试库");
	}
	// 本钩子写全局报价表 exchange_rates：库名闸门与报价更正 E2E 是同一把
	assertRateCacheTestDatabase(decodeURIComponent(url.pathname.slice(1)));

	// e2e 不属于 workspace package，按后端的依赖解析生成的 Prisma 客户端。
	const chatRequire = createRequire(path.join(chatRoot, "package.json"));
	const { PrismaClient } = chatRequire("@prisma/client") as {
		PrismaClient: new (options: { datasourceUrl: string }) => RateCacheDb;
	};
	const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
	try {
		return await run(prisma);
	} finally {
		await prisma.$disconnect();
	}
}

/**
 * 为每个外币种各插入一条新鲜的 frankfurter 缓存行（方向：1 外币 = rate 本位币），
 * 返回插入行（含 id）。任一币种写入失败时回滚已写入的行再抛出，不留半截。
 */
export async function injectFreshRateCacheRows(
	base: string,
	quotes: string[],
	rate = "7.2",
): Promise<InjectedRateRow[]> {
	return withLocalTestDatabase(async (prisma) => {
		const observedAt = new Date();
		const latestConfirmedAt = new Date();
		const rows: InjectedRateRow[] = [];
		try {
			for (const quote of quotes) {
				const row = await prisma.exchangeRate.create({
					data: {
						base,
						quote,
						rate,
						source: "frankfurter",
						observedAt,
						latestConfirmedAt,
						canonicalWriteId: randomUUID(),
					},
					select: { id: true },
				});
				rows.push({ id: row.id, base, quote });
			}
		} catch (error) {
			await prisma.exchangeRate.deleteMany({
				where: { id: { in: rows.map((row) => row.id) } },
			});
			throw error;
		}
		return rows;
	});
}

/** 按 id 清理兜底注入的测试汇率行（只删本进程插入的行，不触碰真实缓存） */
export async function removeRateCacheRows(ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	await withLocalTestDatabase((prisma) =>
		prisma.exchangeRate.deleteMany({ where: { id: { in: ids } } }),
	);
}
