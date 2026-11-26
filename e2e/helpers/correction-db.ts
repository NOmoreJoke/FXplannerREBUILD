import { createRequire } from "node:module";
import path from "node:path";
import { readEnvFile } from "./env-local";

interface CorrectionDb {
	organizationSettings: {
		updateMany(args: {
			where: {
				organization: {
					memberships: { some: { userId: string; role: string } };
				};
			};
			data: { ledgerStartedAt: Date };
		}): Promise<unknown>;
	};
	$disconnect(): Promise<void>;
}

/**
 * 只调整刚创建测试用户的账本起点，以便通过真实 API 造历史交易。
 *
 * W30（MIG-F）：记账起点只存在于 OrganizationSettings（UserSettings 已删除该列）。
 */
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
	const { protocol, hostname, searchParams } = new URL(databaseUrl);
	if (
		(protocol !== "postgresql:" && protocol !== "postgres:") ||
		!["localhost", "127.0.0.1", "[::1]"].includes(hostname) ||
		// Prisma 支持 ?host= 改写连接目标：主机名是回环也不算数
		searchParams.has("host")
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
		// 测试用户只拥有注册时建的个人工作台（OWNER）：按成员关系定位其组织，不全表改
		await prisma.organizationSettings.updateMany({
			where: {
				organization: {
					memberships: { some: { userId: user.userId, role: "OWNER" } },
				},
			},
			data: { ledgerStartedAt },
		});
	} finally {
		await prisma.$disconnect();
	}
}
