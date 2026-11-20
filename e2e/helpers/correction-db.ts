import { createRequire } from "node:module";
import path from "node:path";
import { readEnvFile } from "./env-local";

interface CorrectionDb {
	userSettings: {
		update(args: {
			where: { userId: string; user: { email: string } };
			data: { ledgerStartedAt: Date };
		}): Promise<unknown>;
	};
	$disconnect(): Promise<void>;
}

/** 只调整刚创建测试用户的账本起点，以便通过真实 API 造历史交易。 */
export async function setTestLedgerStart(
	user: { userId: string; email: string },
	ledgerStartedAt: Date,
): Promise<void> {
	const chatRoot = path.resolve(process.cwd(), "services/chat");
	const databaseUrl =
		process.env.DATABASE_URL ??
		readEnvFile(path.join(chatRoot, ".env.local")).DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("日期更正 E2E 需要连接候选后端使用的本地测试库");
	}
	const { protocol, hostname } = new URL(databaseUrl);
	if (
		(protocol !== "postgresql:" && protocol !== "postgres:") ||
		!["localhost", "127.0.0.1", "[::1]"].includes(hostname)
	) {
		throw new Error("日期更正 E2E 仅允许本地 PostgreSQL 测试库");
	}

	// e2e 不属于 workspace package，按后端的依赖解析生成的 Prisma 客户端。
	const chatRequire = createRequire(path.join(chatRoot, "package.json"));
	const { PrismaClient } = chatRequire("@prisma/client") as {
		PrismaClient: new (options: { datasourceUrl: string }) => CorrectionDb;
	};
	const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
	try {
		await prisma.userSettings.update({
			where: { userId: user.userId, user: { email: user.email } },
			data: { ledgerStartedAt },
		});
	} finally {
		await prisma.$disconnect();
	}
}
