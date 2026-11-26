import { createRequire } from "node:module";
import path from "node:path";
import { seedInitialHolding } from "../../services/chat/test/helpers/correction-fixture";
import { readEnvFile } from "./env-local";
import { assertRateCacheTestDatabase } from "./rate-cache-db";

type LedgerDb = Parameters<typeof seedInitialHolding>[0];
type QuoteDb = LedgerDb & {
	$transaction<T>(run: (tx: LedgerDb) => Promise<T>): Promise<T>;
	$disconnect(): Promise<void>;
};

interface HistoricalQuoteFixture {
	holdingId: string;
	replaceSellRate(): Promise<void>;
	readHolding(): Promise<{ currencyCode: string; cost: string }>;
	readAuditStatus(): Promise<string>;
}

/** 在本地测试库构造初始持仓与原时点报价。报价变化由测试驱动，应用请求正常发出。 */
export async function withHistoricalCorrectionQuote(
	user: { userId: string; email: string },
	run: (fixture: HistoricalQuoteFixture) => Promise<void>,
): Promise<void> {
	const chatRoot = path.resolve(process.cwd(), "services/chat");
	const databaseUrl =
		process.env.DATABASE_URL ??
		readEnvFile(path.join(chatRoot, ".env.local")).DATABASE_URL;
	if (!databaseUrl) throw new Error("报价更正 E2E 缺少本地测试数据库");

	const url = new URL(databaseUrl);
	if (
		(url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.searchParams.has("host")
	) {
		throw new Error("报价更正 E2E 仅允许本地 PostgreSQL 测试库");
	}
	const database = decodeURIComponent(url.pathname.slice(1));
	// 本用例会写全局报价表 exchange_rates：库名闸门与汇率缓存兜底共用同一把（rate-cache-db）
	assertRateCacheTestDatabase(database);

	const chatRequire = createRequire(path.join(chatRoot, "package.json"));
	const { PrismaClient } = chatRequire("@prisma/client") as {
		PrismaClient: new (options: { datasourceUrl: string }) => QuoteDb;
	};
	const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
	let quoteId: string | undefined;
	try {
		const { holdingId, quote } = await prisma.$transaction(async (tx) => {
			await tx.user.findUniqueOrThrow({
				where: { id: user.userId, email: user.email },
				select: { id: true },
			});
			// ToB R1：账本行按组织隔离。造数行与 onboarding 写侧同口径落组织（持仓 / 批次 /
			// 账户三行一并），取该用户的 OWNER 组织——注册即建的个人工作台（E2E 用户只有它）。
			// 查不到则不传：保持兼容窗口的 NULL 行，仅默认组织创建者本人在默认组织上下文可见。
			const organization = await tx.organization.findFirst({
				where: {
					memberships: {
						some: { userId: user.userId, role: "OWNER", status: "ACTIVE" },
					},
				},
				orderBy: { createdAt: "asc" },
				select: { id: true },
			});
			// 测试报价是全局记录，放在常用历史窗口以外，避免被当期行情或持仓选中。
			const confirmedAt = new Date(Date.now() - 20 * 365 * 86_400_000);
			const observedAt = new Date(confirmedAt.getTime() - 1000);
			const holding = await seedInitialHolding(tx, {
				userId: user.userId,
				...(organization && { organizationId: organization.id }),
				currencyCode: "USD",
				amount: "1000",
				rate: "7.248",
				cost: "7248",
				confirmedAt,
			});
			const quote = await tx.exchangeRate.create({
				data: {
					base: "CNY",
					quote: "THB",
					source: "abc",
					rate: "0.2",
					sellRate: "0.21",
					observedAt,
					createdAt: observedAt,
				},
				select: { id: true },
			});
			return { ...holding, quote };
		});
		quoteId = quote.id;
		await run({
			holdingId,
			async replaceSellRate() {
				await prisma.exchangeRate.update({
					where: { id: quote.id },
					data: { sellRate: "0.23" },
				});
			},
			async readHolding() {
				const row = await prisma.initialHolding.findUniqueOrThrow({
					where: { id: holdingId },
					select: { currencyCode: true, cost: true },
				});
				return { currencyCode: row.currencyCode, cost: row.cost.toFixed(4) };
			},
			async readAuditStatus() {
				const entry = await prisma.correction.findFirstOrThrow({
					where: { userId: user.userId, targetType: "INITIAL_HOLDING", targetId: holdingId },
					orderBy: { createdAt: "desc" },
					select: { status: true },
				});
				return entry.status;
			},
		});
	} finally {
		try {
			if (quoteId) await prisma.exchangeRate.deleteMany({ where: { id: quoteId } });
		} finally {
			await prisma.$disconnect();
		}
	}
}
