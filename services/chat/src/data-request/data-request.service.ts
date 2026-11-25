import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
import { PrismaService } from "../prisma/prisma.service";
import { env } from "../config/env";
import { OtpService } from "../auth/otp/otp.service";
import type { User } from "@prisma/client";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import {
	ACTIVE_STATUSES,
	assertCredentialUsable,
	computeDueAt,
	resolveAdvance,
	resolveCancel,
	resolveCreationConflict,
	resolveDownload,
	resolveLock,
	toDisplayStatus,
	type DataRequestType,
	type LockResolution,
	type OtpPurpose,
	type VerificationErrorCode,
	type VerificationResolution,
} from "./data-request-rules";
import { DOWNLOAD_TTL_MS } from "./data-request-rules";
import {
	buildExportEntries,
	buildExportZip,
	type ExportBundleData,
} from "./export-builder";
import {
	type CreateDataRequestDto,
	type CancelDataRequestDto,
	DataRequestConflictException,
	DataRequestNotFoundException,
	DataRequestNotCancellableException,
	DataRequestVerificationException,
	DownloadExpiredException,
	ImpactChangedException,
	type ImpactTotalsDto,
	type DataRequestViewDto,
	type ImpactViewDto,
	type VerifyDataRequestDto,
	type VerifyResultDto,
} from "./dto/data-request.dto";

/** 清空/注销删除行数统计（进度与审计日志用） */
type ClearStats = Record<string, number>;

type Tx = Prisma.TransactionClient;

function totalsEqual(
	server: ImpactTotalsDto,
	confirmed: Partial<ImpactTotalsDto> | undefined,
): boolean {
	if (!confirmed) return false;
	return (
		server.accounts === confirmed.accounts &&
		server.transactions === confirmed.transactions &&
		server.initialHoldings === confirmed.initialHoldings &&
		server.plans === confirmed.plans &&
		server.usageRecords === confirmed.usageRecords &&
		server.corrections === confirmed.corrections
	);
}

/**
 * 数据权利请求编排（account-data 技术方案 §3/§5/§6/§7）。
 *
 * Service 只执行不决策：状态流转/互斥/撤回/锁/凭证窗口判定在 data-request-rules，
 * CSV/ZIP 构建在 export-builder。
 */
@Injectable()
export class DataRequestService {
	private readonly logger = new Logger(DataRequestService.name);
	/** 导出文件目录（env.DATA_EXPORT_DIR；fileUrl 只存文件名，不存绝对路径） */
	private readonly exportDir: string;

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(OtpService) private readonly otpService: OtpService,
	) {
		this.exportDir = env.DATA_EXPORT_DIR ?? join(process.cwd(), "data-exports");
	}

	// ─────────────────────────────────────────────────────────
	// 查询
	// ─────────────────────────────────────────────────────────

	/** 当前请求（设置页/进度页）：最近 30 天内非 CANCELLED 的最新请求；无 → null */
	async getCurrentView(userId: string): Promise<DataRequestViewDto | null> {
		const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		const request = await this.prisma.dataRequest.findFirst({
			where: { userId, requestedAt: { gte: since }, status: { not: "CANCELLED" } },
			orderBy: { requestedAt: "desc" },
		});
		return request ? this.toView(request) : null;
	}

	/** CLEAR 确认页数据：各业务记录数量 + 可下载导出提示（方案 §7.4）；未建账 409 对齐 settings 先例 */
	async getImpact(userId: string): Promise<ImpactViewDto> {
		const settings = await this.prisma.userSettings.findUnique({
			where: { userId },
			select: { userId: true, baseCurrency: true },
		});
		if (!settings || !settings.baseCurrency.trim()) {
			throw new OnboardingNotCompletedException();
		}

		const totals = await this.computeTotals(this.prisma, userId);
		const downloadable = await this.prisma.dataRequest.findFirst({
			where: {
				userId,
				type: "EXPORT",
				status: "COMPLETED",
				downloadExpiresAt: { gt: new Date() },
			},
			select: { id: true },
		});
		return { totals, hasDownloadableExport: downloadable !== null };
	}

	// ─────────────────────────────────────────────────────────
	// 验证与提交
	// ─────────────────────────────────────────────────────────

	/**
	 * 数据操作验证（方案 §3.4 第 2 步）：用途先校验（不匹配不消费、不累计尝试），
	 * 再走 OtpService.verifyCode 消费（频控/锁定/尝试数语义全部继承），
	 * 返回 10 分钟确认窗口截止时刻。
	 */
	async verify(dto: VerifyDataRequestDto, user: User): Promise<VerifyResultDto> {
		const challenge = await this.prisma.otpChallenge.findUnique({
			where: { id: dto.challengeId },
		});
		if (!challenge) {
			throw new DataRequestVerificationException("VERIFICATION_INVALID");
		}
		if (challenge.purpose !== dto.purpose) {
			throw new DataRequestVerificationException(
				"VERIFICATION_PURPOSE_MISMATCH",
			);
		}
		if (
			!user.email ||
			challenge.target !== user.email.toLowerCase()
		) {
			// 不得用其他邮箱的凭证操作本人数据（doc 01：不能换邮箱取走数据）
			throw new DataRequestVerificationException("VERIFICATION_INVALID");
		}

		// 消费验证码：码错 → OTP 语义（401/409/410/429）；成功后 challenge 成为凭证
		await this.otpService.verifyCode({
			challengeId: dto.challengeId,
			code: dto.code,
		});

		const consumed = await this.prisma.otpChallenge.findUnique({
			where: { id: dto.challengeId },
		});
		if (!consumed?.consumedAt) {
			throw new DataRequestVerificationException("VERIFICATION_INVALID");
		}
		return {
			challengeId: dto.challengeId,
			purpose: dto.purpose as OtpPurpose,
			confirmDeadline: new Date(
				consumed.consumedAt.getTime() + 10 * 60 * 1000,
			),
		};
	}

	/** 创建请求（方案 §7.5）：互斥 → 凭证 → 影响快照 → 导出链接失效 → 创建/同步生成 */
	async create(dto: CreateDataRequestDto, user: User): Promise<DataRequestViewDto> {
		const settings = await this.prisma.userSettings.findUnique({
			where: { userId: user.id },
			select: { userId: true, baseCurrency: true },
		});
		if (!settings || !settings.baseCurrency.trim()) {
			throw new OnboardingNotCompletedException();
		}

		if (dto.type === "CLEAR" && !dto.confirmedTotals) {
			throw new BadRequestException("清空业务记录必须携带确认时的记录数量快照");
		}

		return this.prisma.$transaction(async (tx) => {
			// 互斥检查的并发兜底：同人串行（对齐 otp.service 的 advisory lock 先例）
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`datareq:${user.id}`}, 0))`;
			const now = new Date();

			// 1. 互斥 / 幂等（重复点击导出返回原请求）
			const existing = await tx.dataRequest.findFirst({
				where: {
					userId: user.id,
					OR: [
						{ status: { in: ACTIVE_STATUSES as string[] } },
						{
							type: "EXPORT",
							status: "COMPLETED",
							downloadExpiresAt: { gt: now },
						},
					],
				},
				orderBy: { requestedAt: "desc" },
			});
			const resolution = resolveCreationConflict(dto.type, existing, now);
			if (resolution.action === "block") {
				throw new DataRequestConflictException(this.toView(existing!));
			}
			if (resolution.action === "return-existing") {
				return this.toView(existing!);
			}

			// 2. 验证凭证校验（用途匹配 / 已消费 / 10 分钟内 / 本人邮箱 / 一次性）
			const challenge = await tx.otpChallenge.findUnique({
				where: { id: dto.challengeId },
			});
			if (!challenge) {
				throw new DataRequestVerificationException("VERIFICATION_INVALID");
			}
			if (challenge.purpose !== dto.type) {
				throw new DataRequestVerificationException(
					"VERIFICATION_PURPOSE_MISMATCH",
				);
			}
			const referenced = await tx.dataRequest.findUnique({
				where: { verifiedChallengeId: dto.challengeId },
				select: { id: true },
			});
			if (referenced) {
				throw new DataRequestVerificationException("VERIFICATION_USED");
			}
			this.throwIfCredentialRejected(
				assertCredentialUsable(
					challenge,
					{ purpose: dto.type, userEmail: user.email },
					now,
				),
			);

			// 3. CLEAR：确认页数量快照与服务端重算一致（记录变化 → 重新确认）
			if (dto.type === "CLEAR") {
				const totals = await this.computeTotals(tx, user.id);
				if (!totalsEqual(totals, dto.confirmedTotals)) {
					throw new ImpactChangedException();
				}
			}

			// 4. CLEAR/DELETION：可下载导出链接立即失效 + 临时文件删除（unlink 失败仅 warn）
			if (dto.type !== "EXPORT") {
				await this.expireDownloadableExports(tx, user.id, now);
			}

			// 5. 创建：EXPORT 同步生成即 COMPLETED；CLEAR/DELETION → PENDING(dueAt=+7d)
			if (dto.type === "EXPORT") {
				return this.createExportSync(tx, user, dto.challengeId, now);
			}
			const created = await tx.dataRequest.create({
				data: {
					userId: user.id,
					type: dto.type,
					status: "PENDING",
					requestedAt: now,
					dueAt: computeDueAt(now),
					verifiedChallengeId: dto.challengeId,
				},
			});
			this.logger.log(
				`[data-request] created type=${dto.type} id=${created.id} userId=${user.id} dueAt=${created.dueAt.toISOString()}`,
			);
			return this.toView(created);
		});
	}

	/** 撤回（方案 §7.6）：CLEAR 直接撤；DELETION 需 DELETION 用途验证码（仅登录不算撤回） */
	async cancel(
		requestId: string,
		user: User,
		dto: CancelDataRequestDto,
	): Promise<DataRequestViewDto> {
		const request = await this.prisma.dataRequest.findUnique({
			where: { id: requestId },
		});
		// 非本人 / 不存在 → 同一响应，不泄露存在性（需求验收 18）
		if (!request || request.userId !== user.id) {
			throw new DataRequestNotFoundException();
		}

		const resolution = resolveCancel(request);
		if (resolution === "not-allowed") {
			throw new DataRequestNotCancellableException();
		}

		if (resolution === "requires-verification") {
			if (!dto.challengeId) {
				// 撤回注销必须「验证邮箱＋点击」两步齐全（doc 01:133）：
				// challengeId 须是 verify 已消费的 DELETION 用途凭证（仅登录不算撤回）
				throw new DataRequestVerificationException("VERIFICATION_INVALID");
			}
			const challenge = await this.prisma.otpChallenge.findUnique({
				where: { id: dto.challengeId },
			});
			if (!challenge) {
				throw new DataRequestVerificationException("VERIFICATION_INVALID");
			}
			if (challenge.purpose !== "DELETION") {
				throw new DataRequestVerificationException(
					"VERIFICATION_PURPOSE_MISMATCH",
				);
			}
			if (!user.email || challenge.target !== user.email.toLowerCase()) {
				throw new DataRequestVerificationException("VERIFICATION_INVALID");
			}
			const referenced = await this.prisma.dataRequest.findUnique({
				where: { verifiedChallengeId: dto.challengeId },
				select: { id: true },
			});
			if (referenced) {
				throw new DataRequestVerificationException("VERIFICATION_USED");
			}
			// 凭证已在 /data-requests/verify 完成码校验与消费；此处仅复验用途/邮箱/窗口
			this.throwIfCredentialRejected(
				assertCredentialUsable(
					challenge,
					{ purpose: "DELETION", userEmail: user.email },
					new Date(),
				),
			);
		}

		const cancelled = await this.prisma.dataRequest.update({
			where: { id: requestId },
			data: { status: "CANCELLED" },
		});
		this.logger.log(
			`[data-request] cancelled type=${cancelled.type} id=${cancelled.id} userId=${user.id}`,
		);
		return this.toView(cancelled);
	}

	// ─────────────────────────────────────────────────────────
	// 读时惰性推进 + 锁判定（方案 §3.1 决策一 + F1-2 单次查询合并）
	// ─────────────────────────────────────────────────────────

	async advanceAndResolveLock(
		userId: string,
		options: { skipLock: boolean; method: string },
	): Promise<{ userDeleted: boolean; lock: LockResolution }> {
		const now = new Date();
		const activeRows = await this.prisma.dataRequest.findMany({
			where: {
				userId,
				type: { in: ["CLEAR", "DELETION"] },
				status: { in: ACTIVE_STATUSES as string[] },
			},
			orderBy: { requestedAt: "asc" },
			select: {
				id: true,
				type: true,
				status: true,
				dueAt: true,
			},
		});

		if (activeRows.length === 0) {
			return { userDeleted: false, lock: null };
		}

		let remaining = activeRows;
		const dueCandidate =
			activeRows.find(
				(row) => row.status === "PENDING" || row.status === "FAILED",
			) ?? null;

		if (resolveAdvance(dueCandidate, now) === "advance" && dueCandidate) {
			try {
				await this.executeCleanup(userId, dueCandidate);
				if (dueCandidate.type === "DELETION") {
					return { userDeleted: true, lock: null };
				}
				// CLEAR 推进成功：已转 COMPLETED，从当次活跃集合移除
				remaining = activeRows.filter((row) => row.id !== dueCandidate.id);
			} catch (error) {
				// 整体回滚 → FAILED（锁保持，残留数据不当作正常账本）；下次读时重试
				await this.prisma.dataRequest
					.update({ where: { id: dueCandidate.id }, data: { status: "FAILED" } })
					.catch(() => undefined);
				this.logger.warn(
					`[data-request] cleanup FAILED type=${dueCandidate.type} id=${dueCandidate.id} userId=${userId}: ${error instanceof Error ? error.message : String(error)}`,
				);
				remaining = activeRows.map((row) =>
					row.id === dueCandidate.id ? { ...row, status: "FAILED" } : row,
				);
			}
		}

		if (options.skipLock) {
			return { userDeleted: false, lock: null };
		}

		// activeRows 按 requestedAt ASC 排序，末尾即最新活跃请求（与原 desc findFirst 等价）
		const latestActive = remaining[remaining.length - 1] ?? null;
		return {
			userDeleted: false,
			lock: resolveLock(latestActive, options.method),
		};
	}

	async advanceDueRequests(userId: string): Promise<void> {
		await this.advanceAndResolveLock(userId, { skipLock: true, method: "GET" });
	}

	/** 清理事务：PENDING/FAILED → PROCESSING → 六步删除 → COMPLETED（DELETION 随 user.delete 消失） */
	private async executeCleanup(
		userId: string,
		request: { id: string; type: string },
	): Promise<void> {
		const startedAt = new Date();
		await this.prisma.$transaction(async (tx) => {
			await tx.dataRequest.update({
				where: { id: request.id },
				data: { status: "PROCESSING" },
			});
			const stats = await this.executeClear(tx, userId, startedAt);
			if (request.type === "CLEAR") {
				await tx.dataRequest.update({
					where: { id: request.id },
					data: { status: "COMPLETED", processedAt: new Date() },
				});
				this.logger.log(
					`[data-request] CLEAR COMPLETED id=${request.id} userId=${userId} rows=${JSON.stringify(stats)}`,
				);
			} else {
				// 注销：物理删 User 行（依法保留清单默认空集，待确认点 1）；
				// data_requests 随级联消失，COMPLETED 语义由「账号不存在」承载
				await tx.user.delete({ where: { id: userId } });
				this.logger.log(
					`[data-request] DELETION COMPLETED id=${request.id} userId=${userId} rows=${JSON.stringify(stats)}`,
				);
			}
		});
	}

	/**
	 * 清空六步（方案 §5.1）：单事务显式按序删除，失败整体回滚。
	 * 保留：users、user_settings（除记账起点）、terms_consents、otp_identities、data_requests。
	 */
	private async executeClear(
		tx: Tx,
		userId: string,
		completedAt: Date,
	): Promise<ClearStats> {
		const stats: ClearStats = {};

		// 裸外键表先删（无 Prisma relation，不靠数据库级联）
		const [planIds, usageIds] = await Promise.all([
			tx.plan.findMany({ where: { userId }, select: { id: true } }),
			tx.usageRecord.findMany({ where: { userId }, select: { id: true } }),
		]);
		stats.usageLotAllocations = usageIds.length
			? (
					await tx.usageLotAllocation.deleteMany({
						where: { usageId: { in: usageIds.map((u) => u.id) } },
					})
				).count
			: 0;
		stats.planAllocations = planIds.length
			? (
					await tx.planAllocation.deleteMany({
						where: { planId: { in: planIds.map((p) => p.id) } },
					})
				).count
			: 0;
		stats.planChangeLogs = planIds.length
			? (
					await tx.planChangeLog.deleteMany({
						where: { planId: { in: planIds.map((p) => p.id) } },
					})
				).count
			: 0;
		// plans 级联 plan_installments（Prisma relation）；其余显式删以统计行数
		stats.plans = (await tx.plan.deleteMany({ where: { userId } })).count;
		stats.usageRecords = (await tx.usageRecord.deleteMany({ where: { userId } })).count;
		stats.corrections = (await tx.correction.deleteMany({ where: { userId } })).count;
		stats.reminders = (await tx.reminder.deleteMany({ where: { userId } })).count;
		stats.costLots = (await tx.costLot.deleteMany({ where: { userId } })).count;
		stats.transactions = (await tx.transaction.deleteMany({ where: { userId } })).count;
		stats.initialHoldings = (await tx.initialHolding.deleteMany({ where: { userId } })).count;
		stats.accounts = (await tx.account.deleteMany({ where: { userId } })).count;

		// 新记账起点：清空完成时刻；其余设置保留＝本位币/偏好不变（doc 13:41）
		await tx.userSettings.update({
			where: { userId },
			data: { ledgerStartedAt: completedAt },
		});
		return stats;
	}

	// ─────────────────────────────────────────────────────────
	// 导出（同步生成 + 下载）
	// ─────────────────────────────────────────────────────────

	/** 下载（方案 §7.7）：本人 + EXPORT COMPLETED + 24h 内；过期/文件缺失 → 410 */
	async loadDownload(
		requestId: string,
		userId: string,
	): Promise<{ buffer: Buffer; filename: string }> {
		const request = await this.prisma.dataRequest.findUnique({
			where: { id: requestId },
		});
		if (
			!request ||
			request.userId !== userId ||
			request.type !== "EXPORT" ||
			request.status !== "COMPLETED"
		) {
			throw new DataRequestNotFoundException();
		}
		if (
			!request.downloadExpiresAt ||
			request.downloadExpiresAt.getTime() <= Date.now() ||
			!request.fileUrl
		) {
			throw new DownloadExpiredException();
		}

		// 顺带惰性清理本人其他过期临时文件（链接已关闭，失败仅 warn）
		void this.purgeExpiredFiles(userId).catch(() => undefined);

		try {
			const buffer = await readFile(join(this.exportDir, request.fileUrl));
			return {
				buffer,
				filename: `fxplanner-export-${request.requestedAt.toISOString().slice(0, 10)}.zip`,
			};
		} catch {
			throw new DownloadExpiredException();
		}
	}

	// ─────────────────────────────────────────────────────────
	// 内部工具
	// ─────────────────────────────────────────────────────────

	private throwIfCredentialRejected(
		resolution: VerificationResolution,
	): void {
		if (!resolution.ok) {
			throw new DataRequestVerificationException(
				resolution.code as VerificationErrorCode,
			);
		}
	}

	/** CLEAR 确认页数量（方案 §7.4 六项） */
	private async computeTotals(
		db: Pick<
			Tx,
			| "account"
			| "transaction"
			| "initialHolding"
			| "plan"
			| "usageRecord"
			| "correction"
		>,
		userId: string,
	): Promise<ImpactTotalsDto> {
		const accounts = await db.account.count({ where: { userId } });
		const transactions = await db.transaction.count({ where: { userId } });
		const initialHoldings = await db.initialHolding.count({ where: { userId } });
		const plans = await db.plan.count({ where: { userId } });
		const usageRecords = await db.usageRecord.count({ where: { userId } });
		const corrections = await db.correction.count({ where: { userId } });
		return {
			accounts,
			transactions,
			initialHoldings,
			plans,
			usageRecords,
			corrections,
		};
	}

	/** 提交 CLEAR/DELETION 时失效本人可下载导出链接并删除临时文件 */
	private async expireDownloadableExports(
		tx: Tx,
		userId: string,
		now: Date,
	): Promise<void> {
		const downloadable = await tx.dataRequest.findMany({
			where: {
				userId,
				type: "EXPORT",
				status: "COMPLETED",
				downloadExpiresAt: { gt: now },
			},
			select: { id: true, fileUrl: true },
		});
		if (downloadable.length === 0) return;
		await tx.dataRequest.updateMany({
			where: { id: { in: downloadable.map((r) => r.id) } },
			data: { downloadExpiresAt: now },
		});
		for (const item of downloadable) {
			if (!item.fileUrl) continue;
			await unlink(join(this.exportDir, item.fileUrl)).catch((error: unknown) => {
				this.logger.warn(
					`[data-request] 导出临时文件删除失败（链接已关闭，忽略）: ${item.fileUrl}: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		}
	}

	/** EXPORT 同步生成：查数据 → CSV/ZIP → 落盘 → COMPLETED（fileUrl 存文件名） */
	private async createExportSync(
		tx: Tx,
		user: User,
		challengeId: string,
		now: Date,
	): Promise<DataRequestViewDto> {
		const data = await this.collectExportData(tx, user.id);
		const zip = await buildExportZip(buildExportEntries(data));

		// 先落盘再建行：行创建失败回滚并清理文件；文件名用随机 UUID（不依赖行 id）
		await mkdir(this.exportDir, { recursive: true });
		const filename = `${randomUUID()}.zip`;
		await writeFile(join(this.exportDir, filename), zip);

		let created;
		try {
			created = await tx.dataRequest.create({
				data: {
					userId: user.id,
					type: "EXPORT",
					status: "COMPLETED",
					requestedAt: now,
					dueAt: computeDueAt(now),
					downloadExpiresAt: new Date(now.getTime() + DOWNLOAD_TTL_MS),
					fileUrl: filename,
					verifiedChallengeId: challengeId,
					processedAt: now,
				},
			});
		} catch (error) {
			await unlink(join(this.exportDir, filename)).catch(() => undefined);
			throw error;
		}
		this.logger.log(
			`[data-request] EXPORT COMPLETED id=${created.id} userId=${user.id} bytes=${zip.length}`,
		);
		return this.toView(created);
	}

	/** 导出数据收集：本人全部数据（只读本人，无验证码/凭证字段） */
	private async collectExportData(
		tx: Tx,
		userId: string,
	): Promise<ExportBundleData> {
		const settings = await tx.userSettings.findUnique({ where: { userId } });
		// PlanAllocation/UsageLotAllocation 为裸外键（无 relation）：先查本人 plan/usage id 再 in 查询
		const [ownPlans, ownUsages] = await Promise.all([
			tx.plan.findMany({ where: { userId }, select: { id: true } }),
			tx.usageRecord.findMany({ where: { userId }, select: { id: true } }),
		]);
		const planIdFilter = { in: ownPlans.map((p) => p.id) };
		const usageIdFilter = { in: ownUsages.map((u) => u.id) };
		const [initialHoldings, transactions, accounts, plans, planAllocations, usageRecords, usageLotAllocations, corrections, termsConsents, dataRequests] =
			await Promise.all([
				tx.initialHolding.findMany({
					where: { userId },
					orderBy: { confirmedAt: "asc" },
				}),
				tx.transaction.findMany({
					where: { userId },
					orderBy: { transactedAt: "asc" },
				}),
				tx.account.findMany({ where: { userId }, orderBy: { currencyCode: "asc" } }),
				tx.plan.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
				tx.planAllocation.findMany({
					where: { planId: planIdFilter },
					orderBy: { createdAt: "asc" },
				}),
				tx.usageRecord.findMany({
					where: { userId },
					orderBy: { usedAt: "asc" },
				}),
				tx.usageLotAllocation.findMany({
					where: { usageId: usageIdFilter },
					orderBy: { createdAt: "asc" },
				}),
				tx.correction.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
				tx.termsConsent.findMany({ where: { userId }, orderBy: { consentedAt: "asc" } }),
				tx.dataRequest.findMany({ where: { userId }, orderBy: { requestedAt: "asc" } }),
			]);

		return {
			generatedAt: new Date(),
			settings:
				settings && settings.baseCurrency.trim()
					? {
							baseCurrency: settings.baseCurrency,
							locale: settings.locale,
							region: settings.region,
							prepPreference: settings.prepPreference,
							reminderEnabled: settings.reminderEnabled,
							ledgerStartedAt: settings.ledgerStartedAt,
							createdAt: settings.createdAt,
							updatedAt: settings.updatedAt,
						}
					: null,
			initialHoldings: initialHoldings.map((row) => ({
				id: row.id,
				currencyCode: row.currencyCode,
				amount: String(row.amount),
				rate: String(row.rate),
				rawRate: String(row.rawRate),
				rateSource: row.rateSource,
				rateObservedAt: row.rateObservedAt,
				cost: String(row.cost),
				confirmedAt: row.confirmedAt,
			})),
			transactions: transactions.map((row) => ({
				id: row.id,
				currencyCode: row.currencyCode,
				quantity: String(row.quantity),
				principalAmount: String(row.principalAmount),
				feeAmount: row.feeAmount === null ? null : String(row.feeAmount),
				exchangeRate: String(row.exchangeRate),
				rateSource: row.rateSource,
				rateObservedAt: row.rateObservedAt,
				planId: row.planId,
				transactedAt: row.transactedAt,
				version: row.version,
				createdAt: row.createdAt,
			})),
			accounts: accounts.map((row) => ({
				id: row.id,
				currencyCode: row.currencyCode,
				balance: String(row.balance),
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			})),
			plans: plans.map((row) => ({
				id: row.id,
				name: row.name,
				pacePreference: row.pacePreference,
				targetCurrency: row.targetCurrency,
				targetAmount: String(row.targetAmount),
				expectUseDate: row.expectUseDate,
				prepLeadDays: row.prepLeadDays,
				latestPrepDate: row.latestPrepDate,
				planStartDate: row.planStartDate,
				status: row.status,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			})),
			planAllocations: planAllocations.map((row) => ({
				id: row.id,
				planId: row.planId,
				amount: String(row.amount),
				usedAmount: String(row.usedAmount),
				createdAt: row.createdAt,
			})),
			usageRecords: usageRecords.map((row) => ({
				id: row.id,
				planId: row.planId,
				currencyCode: row.currencyCode,
				amount: String(row.amount),
				usedAt: row.usedAt,
				version: row.version,
				createdAt: row.createdAt,
			})),
			usageLotAllocations: usageLotAllocations.map((row) => ({
				id: row.id,
				usageId: row.usageId,
				lotId: row.lotId,
				quantity: String(row.quantity),
				cost: String(row.cost),
			})),
			corrections: corrections.map((row) => ({
				id: row.id,
				targetType: row.targetType,
				targetId: row.targetId,
				reason: row.reason,
				status: row.status,
				failReason: row.failReason,
				beforeSnapshot: row.beforeSnapshot,
				afterSnapshot: row.afterSnapshot,
				createdAt: row.createdAt,
			})),
			termsConsents: termsConsents.map((row) => ({
				id: row.id,
				termsVersion: row.termsVersion,
				consentType: row.consentType,
				consentedAt: row.consentedAt,
			})),
			dataRequests: dataRequests.map((row) => ({
				id: row.id,
				type: row.type,
				status: row.status,
				requestedAt: row.requestedAt,
				dueAt: row.dueAt,
				processedAt: row.processedAt,
				downloadExpiresAt: row.downloadExpiresAt,
			})),
		};
	}

	/** 惰性清理本人已过期导出临时文件（下载/创建时触发；失败仅 warn） */
	private async purgeExpiredFiles(userId: string): Promise<void> {
		const expired = await this.prisma.dataRequest.findMany({
			where: {
				userId,
				type: "EXPORT",
				status: "COMPLETED",
				downloadExpiresAt: { lt: new Date() },
				fileUrl: { not: null },
			},
			select: { id: true, fileUrl: true },
		});
		for (const item of expired) {
			if (!item.fileUrl) continue;
			await unlink(join(this.exportDir, item.fileUrl)).catch(() => undefined);
		}
		if (expired.length > 0) {
			this.logger.log(
				`[data-request] purged ${expired.length} expired export file(s) userId=${userId}`,
			);
		}
	}

	/** 请求行 → 展示视图（方案 §7.3：映射/撤回可行性/下载入口由纯函数判定） */
	private toView(request: {
		id: string;
		type: string;
		status: string;
		requestedAt: Date;
		dueAt: Date;
		processedAt: Date | null;
		downloadExpiresAt: Date | null;
	}): DataRequestViewDto {
		const cancelResolution = resolveCancel(request);
		return {
			id: request.id,
			type: request.type as DataRequestType,
			status: request.status,
			requestedAt: request.requestedAt,
			dueAt: request.dueAt,
			processedAt: request.processedAt,
			displayStatus: toDisplayStatus(request.type, request.status),
			canCancel: cancelResolution !== "not-allowed",
			withdrawDeadline:
				request.type === "DELETION" && request.status === "PENDING"
					? request.dueAt
					: null,
			download: resolveDownload(
				{ ...request, id: request.id },
				new Date(),
			),
		};
	}
}
