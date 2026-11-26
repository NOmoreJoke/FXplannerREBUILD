import { createRequire } from "node:module";
import path from "node:path";
import { readEnvFile } from "./env-local";
import { assertRateCacheTestDatabase } from "./rate-cache-db";

interface OrganizationInvitationDb {
	organizationInvitation: {
		update(args: {
			where: { id: string };
			data: { expiresAt: Date };
		}): Promise<unknown>;
	};
	$disconnect(): Promise<void>;
}

/**
 * 将指定邀请置为已过期（仅用于 E2E 覆盖 GWT-8 过期邀请拒绝，不等待 7 天）。
 * 同一函数内校验回环 PostgreSQL、拒绝 `?host=` 参数覆盖，并复用测试库名闸门。
 */
export async function expireInvitationForTest(invitationId: string): Promise<void> {
	const chatRoot = path.resolve(process.cwd(), "services/chat");
	const databaseUrl =
		process.env.DATABASE_URL ??
		readEnvFile(path.join(chatRoot, ".env.local")).DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("组织邀请过期 E2E 需要连接本地 PostgreSQL 测试库");
	}
	const url = new URL(databaseUrl);
	if (
		(url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.searchParams.has("host")
	) {
		throw new Error("组织邀请过期 E2E 仅允许本地 PostgreSQL 测试库");
	}
	assertRateCacheTestDatabase(decodeURIComponent(url.pathname.slice(1)));

	const chatRequire = createRequire(path.join(chatRoot, "package.json"));
	const { PrismaClient } = chatRequire("@prisma/client") as {
		PrismaClient: new (options: { datasourceUrl: string }) => OrganizationInvitationDb;
	};
	const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
	try {
		await prisma.organizationInvitation.update({
			where: { id: invitationId },
			data: { expiresAt: new Date(Date.now() - 60_000) },
		});
	} finally {
		await prisma.$disconnect();
	}
}
