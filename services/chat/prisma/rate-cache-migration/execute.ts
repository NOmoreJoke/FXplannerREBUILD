import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
	executePlanBatches,
	type MigrationExecution,
	type MigrationPlan,
	type MigrationTx,
} from "../../src/rate/rate-migration-plan";

interface TargetIdentity {
	systemId: string;
	databaseOid: string;
	schemaOid: string;
	serverAddress: string | null;
	serverPort: number | null;
}

export function resolveTargetConnection(databaseUrl: string | undefined) {
	if (!databaseUrl || !URL.canParse(databaseUrl)) {
		throw new Error("盘点和写入要求有效的 PostgreSQL DATABASE_URL");
	}
	const url = new URL(databaseUrl);
	if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
		throw new Error("盘点和写入要求 PostgreSQL TCP 连接");
	}
	// 与 Prisma PostgreSQL 连接器一致。ORM 在未指定 schema 时使用 public，
	// 即使数据库角色的 search_path 首位指向其他 schema。
	const host = url.searchParams.getAll("host").at(-1) ?? (url.hostname || "localhost");
	return {
		host: host.replace(/^\[|\]$/g, "").toLowerCase(),
		port: url.port || "5432",
		database: url.pathname.split("/")[1] ?? "postgres",
		schema: url.searchParams.getAll("schema").at(-1) ?? "public",
	};
}

type TargetConnection = ReturnType<typeof resolveTargetConnection>;

export function queryTargetIdentity(
	client: Pick<Prisma.TransactionClient, "$queryRaw">,
	connection: TargetConnection,
) {
	return client.$queryRaw<TargetIdentity[]>`
		SELECT control.system_identifier::text AS "systemId",
		       db.oid::text AS "databaseOid",
		       ns.oid::text AS "schemaOid",
		       pg_catalog.host(pg_catalog.inet_server_addr()) AS "serverAddress",
		       pg_catalog.inet_server_port() AS "serverPort"
		FROM pg_catalog.pg_control_system() AS control
		JOIN pg_catalog.pg_database AS db ON db.datname = pg_catalog.current_database()
		JOIN pg_catalog.pg_namespace AS ns ON ns.nspname::text = ${connection.schema}
	`;
}

/** 将服务器身份与 CLI 实际使用的连接路由绑定。 */
export function fingerprintTarget(
	[target]: TargetIdentity[],
	connection: TargetConnection,
): string {
	if (!target?.serverAddress || !target.serverPort) {
		throw new Error("无法验证迁移目标副本；请使用 PostgreSQL TCP 连接并确认目标 schema 存在");
	}
	return createHash("sha256")
		.update(JSON.stringify([
			"rate-cache-migration/target/v1",
			target.systemId,
			target.databaseOid,
			target.schemaOid,
			target.serverAddress,
			target.serverPort,
			connection.host,
			connection.port,
			connection.database,
		]))
		.digest("hex");
}

export async function verifyTargetFingerprint(
	client: Pick<Prisma.TransactionClient, "$queryRaw">,
	connection: TargetConnection,
	fingerprint: unknown,
): Promise<void> {
	if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
		throw new Error("写入要求有效的目标副本指纹；旧清单仅可预览，请在确认后的目标副本重新盘点");
	}
	const identity = await queryTargetIdentity(client, connection);
	if (fingerprintTarget(identity, connection) !== fingerprint) {
		throw new Error("冻结清单的目标副本与当前连接不一致；请核对 DATABASE_URL");
	}
}

/** verifyFrozenPlan 已将圈选集合归一为按 id 排列的重算候选。 */
function checksumOfApprovedScope(plan: MigrationPlan, version: "v1" | "v2"): string {
	const scope = plan.candidates.map(({ row, batch, originalRate, expectedRate }) => [
		row.id,
		row.base,
		row.quote,
		row.source,
		row.sellRate,
		row.observedAt,
		row.createdAt,
		batch,
		originalRate,
		expectedRate,
	]);
	return createHash("sha256")
		.update(JSON.stringify([`rate-cache-migration/${version}`, scope]))
		.digest("hex");
}

export function requireInventoryId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
	) {
		throw new Error(
			"写入要求新版 inventory 生成的 inventoryId；旧清单仅可预览，旧版转换须按原备份恢复",
		);
	}
	return value;
}

/** 在 CLI 的同一个事务内确认或写入台账，并执行全部批次。 */
export async function executeFrozenPlan(
	tx: Prisma.TransactionClient,
	inventoryId: string,
	plan: MigrationPlan,
	reverse: boolean,
) {
	const receipts = tx.rateCacheMigrationReceipt;
	const scopeChecksum = checksumOfApprovedScope(plan, "v2");
	const receipt = await receipts.findUnique({ where: { id: inventoryId } });
	const legacyReceipt = receipt !== null && receipt.scopeChecksum !== scopeChecksum &&
		receipt.scopeChecksum === checksumOfApprovedScope(plan, "v1");
	let mode: MigrationExecution["mode"];
	if (receipt === null) {
		if (reverse) {
			throw new Error("找不到该清单的已提交迁移记录，禁止回滚");
		}
		await receipts.create({ data: { id: inventoryId, scopeChecksum } });
		mode = "invert";
	} else {
		if (receipt.scopeChecksum !== scopeChecksum && !legacyReceipt) {
			throw new Error("清单圈选或冻结字段与已提交迁移记录不一致");
		}
		if (receipt.rolledBackAt !== null && !reverse) {
			throw new Error("该清单已回滚；再次转换需重新盘点并圈选");
		}
		if (reverse) {
			mode = receipt.rolledBackAt === null ? "rollback" : "verify-rolled-back";
		} else {
			mode = "verify-inverted";
		}
	}

	const migrationTx: MigrationTx = {
		updateMany: (args) => tx.exchangeRate.updateMany(args),
		async findUnique({ where }) {
			const row = await tx.exchangeRate.findUnique({ where });
			return row && {
				...row,
				rate: row.rate.toFixed(),
				sellRate: row.sellRate?.toFixed() ?? null,
			};
		},
	};
	const summary = await executePlanBatches(migrationTx, plan, {
		inventoryId,
		mode,
		legacyReceipt,
	});
	if (mode === "rollback") {
		await receipts.update({
			where: { id: inventoryId },
			data: { rolledBackAt: new Date() },
		});
	}
	return summary;
}
