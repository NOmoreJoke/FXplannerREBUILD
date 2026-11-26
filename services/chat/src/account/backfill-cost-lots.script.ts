/**
 * 存量交易成本批次回填（account-module 技术方案 §3.5）：幂等脚本，发布后立即执行一次。
 *
 * 流程（§3.5）：
 * 1. 全量遍历 Transaction，按 (organizationId, currencyCode) 分组
 *    （W30 MIG-E/F：账本行按组织归属，原 (userId, currencyCode) 口径已废）；
 * 2. 每分组一个事务，事务内第一句获取 PostgreSQL advisory **xact** 锁（固定键），
 *    拿不到 → 整个脚本退出并报「另一回填实例运行中」。
 *    ⚠️ 锁实现裁量说明：方案原文为会话级 pg_advisory_lock，但 Prisma 连接池无会话粘滞
 *    （每个查询可能走不同连接，会话锁不可用），故等价实现为「每分组事务内 xact 锁
 *    （pg_try_advisory_xact_lock，事务结束自动释放）+ 组内复检」双保险——单实例互斥
 *    意图不变（§9.11 唯一约束评估遗留不变，冻结解除后以唯一索引作最终防线）；
 * 3. 事务内复检：sourceType="PURCHASE" 且 sourceId 已存在的跳过（幂等，可重跑）；
 * 4. 缺失的按 §3.4 同一纯函数 buildPurchaseLot 构造（与实时录入共用，含容量预校验）；
 *    单条构造异常（如 unitCost 溢出的存量脏数据）catch 跳过并计入 skipped 明细，
 *    不中断该分组内其他条目与其他分组；缺失条目 createMany 插入；
 * 5. 全部分组完成后不变式校验（§3.5 第 4 步）：Σ remainingQty = balance 用**单条聚合 SQL**
 *    （LEFT JOIN，禁止两条独立查询——并发录入恰在两查之间提交会造成误报）；
 *    重复批次检测另一条 SQL（sourceType+sourceId 分组 count > 1 即违规，$queryRaw
 *    的 COUNT 返回 BigInt，转 Number）；
 * 6. 违规/重复**不静默修复**：结构化结果原样返回，CLI 打印明细并以非零码退出，人工按 doc 02/09 更正。
 *
 * 可测试性：核心逻辑导出为 runBackfill(prisma)（返回结构化 BackfillResult），
 * CLI 入口仅在直接执行本文件时运行（vitest import 不触发）。
 */
import path from "path";
import { config as dotenvConfig } from "dotenv";
import { PrismaClient, type Prisma } from "@prisma/client";
import { buildPurchaseLot } from "./account-calculator";

// 环境变量加载对齐 vitest.config.ts：先 monorepo 根 .env.local，再 services/chat/.env.local
// （前者优先；dotenv 不覆盖已存在的变量）。tsx 以 CJS 运行，__dirname = src/account。
const serviceRoot = path.resolve(__dirname, "../..");
const repoRoot = path.resolve(serviceRoot, "../..");
dotenvConfig({ path: path.join(repoRoot, ".env.local") });
dotenvConfig({ path: path.join(serviceRoot, ".env.local") });

/**
 * advisory lock 固定键（int4 范围内任意常量，"backfill-cost-lots" 的语义化编号）；
 * 并发双跑下「先查后插」无唯一约束兜底（M0 冻结，§9.11），只能以互斥防重复批次。
 */
const BACKFILL_ADVISORY_LOCK_KEY = 740112003;

/** 单条跳过明细（§7 回填明细允许打印触发异常的具体数值/原因） */
export interface BackfillSkipped {
	/** 被跳过的交易 ID（sourceId） */
	sourceId: string;
	/** 跳过原因（如 unitCost 溢出的 400 message） */
	reason: string;
}

/** 重复批次明细（同 (organizationId, currency, sourceType, sourceId) 多行） */
export interface BackfillDuplicate {
	organizationId: string;
	currencyCode: string;
	sourceType: string;
	sourceId: string;
	count: number;
}

/** 不变式违规明细：balance ≠ Σ remainingQty（单条聚合 SQL 检出） */
export interface BackfillInvariantViolation {
	organizationId: string;
	currencyCode: string;
	/** Account.balance（toFixed(4)） */
	balance: string;
	/** Σ remainingQty（toFixed(4)；无批次时 "0.0000"） */
	lotRemainingQty: string;
}

/** runBackfill 结构化结果（CLI 据此打日志并决定退出码；测试据此断言） */
export interface BackfillResult {
	/** advisory 锁是否全程获取成功；false = 另一回填实例运行中，脚本应非零退出 */
	acquiredLock: boolean;
	/** 处理的组织数（去重） */
	processedOrganizations: number;
	/** 本次补写的批次数 */
	createdLots: number;
	/** 单条构造失败跳过明细（不中断其他条目/分组） */
	skipped: BackfillSkipped[];
	/** 重复批次明细 */
	duplicates: BackfillDuplicate[];
	/** 不变式违规明细 */
	invariantViolations: BackfillInvariantViolation[];
}

interface TransactionGroup {
	organizationId: string;
	currencyCode: string;
	transactions: Prisma.TransactionGetPayload<Record<string, never>>[];
}

/** 全量交易按 (organizationId, currencyCode) 分组 */
function groupTransactions(
	transactions: Prisma.TransactionGetPayload<Record<string, never>>[],
): TransactionGroup[] {
	const groups = new Map<string, TransactionGroup>();
	for (const transaction of transactions) {
		const key = `${transaction.organizationId}|${transaction.currencyCode}`;
		const group = groups.get(key);
		if (group) {
			group.transactions.push(transaction);
		} else {
			groups.set(key, {
				organizationId: transaction.organizationId,
				currencyCode: transaction.currencyCode,
				transactions: [transaction],
			});
		}
	}
	return [...groups.values()];
}

/**
 * 回填主流程（§3.5，幂等可重跑）。
 * 抛错（如 DB 不可达）原样上抛，由调用方处理；单条构造异常不抛（计入 skipped）。
 */
export async function runBackfill(
	prisma: PrismaClient,
): Promise<BackfillResult> {
	const result: BackfillResult = {
		acquiredLock: true,
		processedOrganizations: 0,
		createdLots: 0,
		skipped: [],
		duplicates: [],
		invariantViolations: [],
	};

	// 1. 全量交易分组（单次全量查询按 organizationId+currencyCode 分组）
	// @org-scope-exempt: 一次性历史回填脚本全量读取交易并按 organizationId+currencyCode 分组
	const transactions = await prisma.transaction.findMany();
	const groups = groupTransactions(transactions);

	// 2~4. 分组事务：xact 锁 → 复检 → buildPurchaseLot → createMany
	const processedOrganizationIds = new Set<string>();
	for (const group of groups) {
		const groupCreated = await prisma.$transaction(async (tx) => {
			// 事务内第一句：xact 锁（该事务内所有查询绑定同一连接，锁在本事务内有效；
			// 事务结束自动释放，下一分组重新竞争——另一实例若持锁则本组立即失败退出）
			const lockRows = await tx.$queryRaw<
				Array<{ locked: boolean }>
			>`SELECT pg_try_advisory_xact_lock(${BACKFILL_ADVISORY_LOCK_KEY}) AS locked`;
			if (!lockRows[0]?.locked) {
				return null;
			}

			// 组内复检（幂等）：与实时录入第④步/上一轮回填可能交错，已存在的跳过
			const existing = await tx.costLot.findMany({
				where: {
					organizationId: group.organizationId,
					currencyCode: group.currencyCode,
					sourceType: "PURCHASE",
					sourceId: { in: group.transactions.map((t) => t.id) },
				},
				select: { sourceId: true },
			});
			const existingSourceIds = new Set(existing.map((lot) => lot.sourceId));

			const missing = group.transactions.filter(
				(transaction) => !existingSourceIds.has(transaction.id),
			);
			const lotsToCreate: Prisma.CostLotUncheckedCreateInput[] = [];
			for (const transaction of missing) {
				try {
					// 与实时录入共用同一构造函数（含 unitCost 容量预校验，§3.4）
					lotsToCreate.push(buildPurchaseLot(transaction));
				} catch (error) {
					// 单条失败（如存量脏数据 unitCost 溢出）跳过并计入明细，不中断分组
					result.skipped.push({
						sourceId: transaction.id,
						reason: error instanceof Error ? error.message : String(error),
					});
				}
			}
			if (lotsToCreate.length > 0) {
				await tx.costLot.createMany({
					data: lotsToCreate,
				});
			}
			return lotsToCreate.length;
		});

		// 拿不到锁：另一回填实例运行中，整个脚本退出（已成功分组保留，重跑幂等）
		if (groupCreated === null) {
			result.acquiredLock = false;
			return result;
		}
		result.createdLots += groupCreated;
		processedOrganizationIds.add(group.organizationId);
	}
	result.processedOrganizations = processedOrganizationIds.size;

	// 5a. 不变式校验（单条聚合 SQL：balance 与 Σ remainingQty 一次 JOIN 检出，§3.5）
	// @org-scope-exempt: 一次性历史回填脚本不变式全库核对（balance vs Σ remaining_qty）
	const violations = await prisma.$queryRaw<
		Array<{
			organization_id: string;
			currency_code: string;
			balance: Prisma.Decimal;
			lot_qty: Prisma.Decimal;
		}>
	>`
		SELECT a.organization_id, a.currency_code, a.balance,
			COALESCE(l.sum_qty, 0) AS lot_qty
		FROM accounts a
		LEFT JOIN (
			SELECT organization_id, currency_code, SUM(remaining_qty) AS sum_qty
			FROM cost_lots
			GROUP BY organization_id, currency_code
		) l ON l.organization_id = a.organization_id AND l.currency_code = a.currency_code
		WHERE a.balance <> COALESCE(l.sum_qty, 0)
	`;
	result.invariantViolations = violations.map((row) => ({
		organizationId: row.organization_id,
		currencyCode: row.currency_code,
		balance: row.balance.toFixed(4),
		lotRemainingQty: row.lot_qty.toFixed(4),
	}));

	// 5b. 重复批次检测（COUNT 返回 BigInt，转 Number；CUID 精度在 Number 安全整数内无虞）
	// @org-scope-exempt: 一次性历史回填脚本重复批次全库检测
	const duplicates = await prisma.$queryRaw<
		Array<{
			organization_id: string;
			currency_code: string;
			source_type: string;
			source_id: string;
			lot_count: bigint;
		}>
	>`
		SELECT organization_id, currency_code, source_type, source_id,
			COUNT(*)::bigint AS lot_count
		FROM cost_lots
		GROUP BY organization_id, currency_code, source_type, source_id
		HAVING COUNT(*) > 1
	`;
	result.duplicates = duplicates.map((row) => ({
		organizationId: row.organization_id,
		currencyCode: row.currency_code,
		sourceType: row.source_type,
		sourceId: row.source_id,
		count: Number(row.lot_count),
	}));

	return result;
}

/** CLI 入口：打印回填日志（§7）并按结果决定退出码（0 成功 / 1 失败） */
async function main(): Promise<void> {
	const startedAt = Date.now();
	console.log("[backfill-cost-lots] 开始存量交易成本批次回填…");
	if (!process.env.DATABASE_URL) {
		console.error(
			"[backfill-cost-lots] 缺少 DATABASE_URL 环境变量（已尝试加载 .env.local），退出",
		);
		process.exit(1);
	}
	const prisma = new PrismaClient();
	try {
		const result = await runBackfill(prisma);

		if (!result.acquiredLock) {
			console.error(
				"[backfill-cost-lots] 另一回填实例运行中（advisory lock 被占用），本次退出；稍后重跑即可（幂等）",
			);
			process.exit(1);
		}

		console.log(
			`[backfill-cost-lots] 处理组织 ${result.processedOrganizations} 个，补写批次 ${result.createdLots} 条，跳过 ${result.skipped.length} 条，耗时 ${Date.now() - startedAt}ms`,
		);
		for (const skipped of result.skipped) {
			console.warn(
				`[backfill-cost-lots] 跳过 sourceId=${skipped.sourceId}：${skipped.reason}`,
			);
		}

		let failed = false;
		if (result.duplicates.length > 0) {
			failed = true;
			console.error(
				`[backfill-cost-lots] 检出重复批次 ${result.duplicates.length} 组（不静默修复，按 doc 02/09 人工更正）：`,
			);
			for (const duplicate of result.duplicates) {
				console.error(
					`  organizationId=${duplicate.organizationId} currencyCode=${duplicate.currencyCode} sourceType=${duplicate.sourceType} sourceId=${duplicate.sourceId} count=${duplicate.count}`,
				);
			}
		}
		if (result.invariantViolations.length > 0) {
			failed = true;
			console.error(
				`[backfill-cost-lots] 检出不变式违规 ${result.invariantViolations.length} 行（balance ≠ Σ remainingQty，不静默修复）：`,
			);
			for (const violation of result.invariantViolations) {
				console.error(
					`  organizationId=${violation.organizationId} currencyCode=${violation.currencyCode} balance=${violation.balance} lotRemainingQty=${violation.lotRemainingQty}`,
				);
			}
		}
		if (failed) {
			console.error("[backfill-cost-lots] 校验未通过，以非零码退出");
			process.exit(1);
		}
		console.log("[backfill-cost-lots] 回填完成，校验全部通过");
	} finally {
		await prisma.$disconnect();
	}
}

// 仅直接执行本文件时运行 CLI（vitest import 本模块不触发）
if (
	process.argv[1] !== undefined &&
	process.argv[1].endsWith("backfill-cost-lots.script.ts")
) {
	void main();
}
