import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
import { PrismaService } from "../prisma/prisma.service";
import { env } from "../config/env";
import { OtpService } from "../auth/otp/otp.service";
import type { DataRequest, Prisma, User } from "@prisma/client";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	AuditService,
	recordDeniedAuditBestEffort,
} from "../audit/audit.service";
import {
	isOrganizationRole,
	type OrganizationRole,
	type Permission,
} from "../authorization/authorization.types";
import {
	OrganizationNotFoundException,
	PermissionDeniedException,
} from "../authorization/authorization.errors";
import { can } from "../authorization/permission-policy";
import { lockOrganizationForActor } from "../organization/default-organization";
import { resolveOrganizationPreferences } from "../organization/organization-preferences";
import {
	ACTIVE_STATUSES,
	assertCredentialUsable,
	auditActionOf,
	computeDueAt,
	requiredPermission,
	resolveAdvance,
	resolveCancel,
	resolveCreationConflict,
	resolveDownload,
	resolveOrganizationLock,
	resolvePersonalLock,
	resolveScopeType,
	toDisplayStatus,
	type DataRequestAuditVerb,
	type DataRequestScope,
	type DataRequestType,
	type OrganizationLockResolution,
	type PersonalLockResolution,
	type OtpPurpose,
	type VerificationErrorCode,
	type VerificationResolution,
} from "./data-request-rules";
import { DOWNLOAD_TTL_MS } from "./data-request-rules";
import {
	buildOrganizationExportArchive,
	buildPersonalExportArchive,
	type ExportDataRequestRow,
	type ExportSettingsRow,
	type OrganizationExportBundleData,
	type PersonalExportBundleData,
} from "./export-builder";
import {
	executeOrganizationRequest,
	executePersonalDeletion,
	findLastOwnerBlocking,
	organizationLedgerScope,
	type CleanupOutcome,
	type CleanupResult,
	type DueRequest,
	type OrganizationLedgerScope,
} from "./data-request-cleanup";
import {
	type CreateDataRequestDto,
	type CancelDataRequestDto,
	DataRequestConflictException,
	DataRequestLastOwnerRequiredException,
	DataRequestNotFoundException,
	DataRequestNotCancellableException,
	DataRequestScopeMismatchException,
	DataRequestVerificationException,
	DownloadExpiredException,
	ImpactChangedException,
	type ImpactTotalsDto,
	type DataRequestViewDto,
	type ImpactViewDto,
	type VerifyDataRequestDto,
	type VerifyResultDto,
} from "./dto/data-request.dto";

type Tx = Prisma.TransactionClient;

/**
 * 数据域上下文（技术方案 §9.1–§9.2 双域物理拆分）。
 *
 * - PERSONAL：个人身份与个人数据（不挂组织、不涉及组织角色）；
 * - ORGANIZATION：当前组织的共享账本与组织数据——目标组织由**组织上下文守卫**
 *   解析（X-Organization-Id），Service 只消费已解析结果，不再自行猜组织。
 */
export type DataRequestDomain =
	| { scope: "PERSONAL"; organizationId: null; membershipId: null }
	| {
			scope: "ORGANIZATION";
			organizationId: string;
			membershipId: string;
	  };

/**
 * 到期清理事务参数：显式超时，不依赖 PrismaClient 的交互式事务默认值（仅 5s）——
 * 大账本的清空 / 组织删除可能远超 5s，超时即整体回滚置 FAILED 待重试。
 */
const CLEANUP_TX_OPTIONS = { maxWait: 30_000, timeout: 120_000 } as const;

/**
 * 导出文件名形态（createExportSync 生成的 `${uuid}.zip`）：只接受裸文件名，
 * 杜绝库内值被篡改后的路径穿越（exportDir 之外的文件一律读不到、删不到）。
 */
const EXPORT_FILENAME_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.zip$/;

/** 读时推进的单次查询选出的行（锁判定数据源 + 到期候选） */
interface ActiveRequestRow {
	id: string;
	userId: string;
	scope: string;
	organizationId: string | null;
	type: string;
	status: string;
	requestedAt: Date;
	dueAt: Date;
}

/** 锁查询的公共列（个人域单查与双锁合并查共用） */
const LOCK_ROW_SELECT = {
	id: true,
	userId: true,
	scope: true,
	organizationId: true,
	type: true,
	status: true,
	requestedAt: true,
	dueAt: true,
} as const;

/** 请求行 → 视图所需的字段 */
type RequestViewSource = Pick<
	ActiveRequestRow,
	"id" | "scope" | "organizationId" | "type" | "status" | "requestedAt" | "dueAt"
> & { processedAt: Date | null; downloadExpiresAt: Date | null };

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

/** 请求行 → 导出行（数据域随行导出：个人包只有 PERSONAL，组织包只有 ORGANIZATION） */
function toExportDataRequestRow(row: Pick<
	DataRequest,
	| "id"
	| "scope"
	| "type"
	| "status"
	| "requestedAt"
	| "dueAt"
	| "processedAt"
	| "downloadExpiresAt"
>): ExportDataRequestRow {
	return {
		id: row.id,
		scope: row.scope,
		type: row.type,
		status: row.status,
		requestedAt: row.requestedAt,
		dueAt: row.dueAt,
		processedAt: row.processedAt,
		downloadExpiresAt: row.downloadExpiresAt,
	};
}

/**
 * 数据权利请求编排（account-data 技术方案 §3/§5/§6/§7；ToB R1 技术方案 §9 双域拆分）。
 *
 * Service 只执行不决策：状态流转 / 互斥 / 撤回 / 锁 / scope×type 合法性 / 最后 Owner 阻塞
 * 在 data-request-rules，CSV/ZIP 构建在 export-builder，事务内清理在 data-request-cleanup。
 *
 * 双域（Goal #3B W26）：
 * - PERSONAL EXPORT / DELETION：个人身份与个人数据，不挂组织、不涉及组织角色；
 * - ORGANIZATION EXPORT / CLEAR / DELETION：当前组织的账本与组织数据。目标组织取
 *   X-Organization-Id（单组织用户可缺省）；创建 / 撤回在事务内持组织成员锁重读角色，
 *   按 data.export / data.clear / organization.delete 判权，并与审计同事务。
 */
@Injectable()
export class DataRequestService {
	private readonly logger = new Logger(DataRequestService.name);
	/** 导出文件目录（env.DATA_EXPORT_DIR；fileUrl 只存文件名，不存绝对路径） */
	private readonly exportDir: string;

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(OtpService) private readonly otpService: OtpService,
		@Inject(AuditService) private readonly auditService: AuditService,
	) {
		this.exportDir = env.DATA_EXPORT_DIR ?? join(process.cwd(), "data-exports");
	}

	// ─────────────────────────────────────────────────────────
	// 查询
	// ─────────────────────────────────────────────────────────

	/**
	 * 当前请求（设置页/进度页）：最近 30 天内非 CANCELLED 的最新请求；无 → null。
	 *
	 * 双域拆分（技术方案 §9.1）：个人域只看本人名下的 PERSONAL 请求；组织域看
	 * 当前组织名下的 ORGANIZATION 请求（任意有效成员可查，见组织端点）。
	 */
	async getCurrentView(
		userId: string,
		scope: DataRequestScope,
	): Promise<DataRequestViewDto | null> {
		const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		const request = await this.prisma.dataRequest.findFirst({
			where: {
				userId,
				scope,
				requestedAt: { gte: since },
				status: { not: "CANCELLED" },
			},
			orderBy: { requestedAt: "desc" },
		});
		return request ? this.toView(request) : null;
	}

	/** 组织域当前请求（组织进度页）：当前组织最近 30 天内非 CANCELLED 的最新请求 */
	async getOrganizationCurrentView(
		organizationId: string,
	): Promise<DataRequestViewDto | null> {
		const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		const request = await this.prisma.dataRequest.findFirst({
			where: {
				organizationId,
				scope: "ORGANIZATION",
				requestedAt: { gte: since },
				status: { not: "CANCELLED" },
			},
			orderBy: { requestedAt: "desc" },
		});
		return request ? this.toView(request) : null;
	}

	/**
	 * 清空确认页数据（方案 §7.4）：**当前组织**各业务记录数量 + 可下载导出提示；
	 * 目标组织由组织上下文守卫解析（Service 不再自行猜组织）；需 data.clear 权限。
	 * 记录数量口径与清空 / 导出同一账本作用域（organizationLedgerScope）。
	 */
	async getImpact(
		userId: string,
		organizationId: string,
	): Promise<ImpactViewDto> {
		const membership = await this.prisma.membership.findUniqueOrThrow({
			where: {
				organizationId_userId: { organizationId, userId },
			},
			select: { role: true },
		});
		if (!isOrganizationRole(membership.role)) {
			throw new PermissionDeniedException("成员角色无效，拒绝访问");
		}
		this.assertOrganizationPermission(membership.role, "data.clear", {
			organizationId,
			userId,
		});
		if (!(await resolveOrganizationPreferences(this.prisma, organizationId))) {
			throw new OnboardingNotCompletedException();
		}
		const scope = await organizationLedgerScope(this.prisma, organizationId);
		const totals = await this.computeTotals(this.prisma, scope);
		const downloadable = await this.prisma.dataRequest.findFirst({
			where: {
				organizationId,
				scope: "ORGANIZATION",
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

	/**
	 * 创建请求（方案 §7.5）：互斥 → 凭证 → 数据域与目标组织（判权 / 最后 Owner）→
	 * 影响快照 → 同域导出链接失效 → 创建 / 同步生成。
	 *
	 * 双域物理拆分（技术方案 §9.1–§9.2）：数据域由**端点**决定（个人端点只受理
	 * PERSONAL，组织端点只受理 ORGANIZATION），请求体显式 scope 与端点数据域不一致
	 * 一律 400 SCOPE_TYPE_MISMATCH；个人域不设「未建账」门槛（个人数据权利只需
	 * 本人 + 二次验证），组织域须已建账且按 data.export / data.clear /
	 * organization.delete 判权。
	 */
	async create(
		dto: CreateDataRequestDto,
		user: User,
		domain: DataRequestDomain,
	): Promise<DataRequestViewDto> {
		// ── 数据域一致性优先（评审 N-2）：scope / scope×type 合法性先于业务参数校验，
		//    免得「个人端点发 CLEAR」被 confirmedTotals 的 400 抢先（错误码不一致）
		if (dto.scope !== undefined && dto.scope !== domain.scope) {
			throw new DataRequestScopeMismatchException(
				domain.scope === "PERSONAL"
					? "该端点只受理个人域请求（PERSONAL）；组织域请使用组织数据请求端点"
					: "该端点只受理组织域请求（ORGANIZATION）；个人域请使用个人数据请求端点",
			);
		}
		// scope × type × 组织 合法性（与 DB CHECK 同口径）
		const combination = resolveScopeType({
			scope: domain.scope,
			type: dto.type,
			organizationId: domain.organizationId,
		});
		if (!combination.ok) {
			throw new DataRequestScopeMismatchException(
				domain.scope === "PERSONAL"
					? "清空业务记录属于组织数据，请以当前组织提交"
					: "个人数据请求不属于组织域，请以个人身份提交",
			);
		}
		if (dto.type === "CLEAR" && !dto.confirmedTotals) {
			throw new BadRequestException("清空业务记录必须携带确认时的记录数量快照");
		}
		const scope: DataRequestScope = domain.scope;

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
			// 幂等返回仅限同域同组织：个人导出不能顶替组织导出（反之亦然）。
			// 个人域在此即可判定；组织域须等目标组织解析后再比对（见步骤 3）
			if (
				resolution.action === "return-existing" &&
				scope === "PERSONAL" &&
				existing!.scope === "PERSONAL"
			) {
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

			// 3. 数据域：目标组织与判权（组织域）/ 最后 Owner（个人注销）
			let targetOrganizationId: string | null = null;
			if (domain.scope === "ORGANIZATION") {
				targetOrganizationId = await this.authorizeOrganizationRequest(
					tx,
					user.id,
					dto.type,
					domain,
				);
				// 组织级互斥：同一组织已有任何成员发起的进行中组织请求 → 409（附原请求）
				const organizationActive = await tx.dataRequest.findFirst({
					where: {
						organizationId: targetOrganizationId,
						scope: "ORGANIZATION",
						status: { in: ACTIVE_STATUSES as string[] },
					},
					orderBy: { requestedAt: "desc" },
				});
				if (organizationActive) {
					throw new DataRequestConflictException(
						this.toView(organizationActive),
					);
				}
				// 组织数据请求以组织已建账为前提（本位币决定导出口径与清空后的记账起点）——
				// **仅 EXPORT / CLEAR**：ORGANIZATION DELETION 不受此限（评审 I-4），
				// 否则「未建账组织的唯一 Owner」既不能删组织、也不能注销个人账号 → 死锁
				// （组织删除的清理路径不依赖 OrganizationSettings）。
				if (
					dto.type !== "DELETION" &&
					!(await resolveOrganizationPreferences(tx, targetOrganizationId))
				) {
					throw new OnboardingNotCompletedException();
				}
				if (dto.type === "EXPORT") {
					// 同域幂等：该组织已有本人仍可下载的组织导出 → 返回原请求，不重复生成
					const downloadable = await tx.dataRequest.findFirst({
						where: {
							userId: user.id,
							organizationId: targetOrganizationId,
							scope: "ORGANIZATION",
							type: "EXPORT",
							status: "COMPLETED",
							downloadExpiresAt: { gt: now },
						},
						orderBy: { requestedAt: "desc" },
					});
					if (downloadable) {
						return this.toView(downloadable);
					}
				}
			} else if (dto.type === "DELETION") {
				// 最后 Owner 保护（创建阶段；到期执行时在组织锁内重读复验）
				const blocking = await findLastOwnerBlocking(tx, user.id);
				if (blocking.length > 0) {
					throw new DataRequestLastOwnerRequiredException(blocking);
				}
			}

			// 4. CLEAR：确认页数量快照与服务端重算一致（记录变化 → 重新确认）
			if (dto.type === "CLEAR") {
				const totals = await this.computeTotals(
					tx,
					await organizationLedgerScope(tx, targetOrganizationId!),
				);
				if (!totalsEqual(totals, dto.confirmedTotals)) {
					throw new ImpactChangedException();
				}
			}

			// 5. CLEAR/DELETION：同域可下载导出链接立即失效 + 临时文件删除（unlink 失败仅 warn）
			if (dto.type !== "EXPORT") {
				await this.expireDownloadableExports(
					tx,
					{ userId: user.id, scope, organizationId: targetOrganizationId },
					now,
				);
			}

			// 6. 创建：EXPORT 同步生成即 COMPLETED；CLEAR/DELETION → PENDING(dueAt=+7d)
			if (dto.type === "EXPORT") {
				return this.createExportSync(
					tx,
					user.id,
					scope,
					targetOrganizationId,
					dto.challengeId,
					now,
				);
			}
			const created = await tx.dataRequest.create({
				data: {
					userId: user.id,
					scope,
					organizationId: targetOrganizationId,
					type: dto.type,
					status: "PENDING",
					requestedAt: now,
					dueAt: computeDueAt(now),
					verifiedChallengeId: dto.challengeId,
				},
			});
			await this.recordOrganizationAudit(
				tx,
				scope,
				dto.type,
				"create",
				created.id,
				{ userId: user.id, organizationId: targetOrganizationId },
			);
			this.logger.log(
				`[data-request] created scope=${scope} type=${dto.type} id=${created.id} userId=${user.id} organizationId=${created.organizationId ?? "-"} dueAt=${created.dueAt.toISOString()}`,
			);
			return this.toView(created);
		});
	}

	/**
	 * 组织域请求的授权（技术方案 §4.3 / §6.3）：目标组织由组织上下文守卫解析 →
	 * 持组织成员锁重读最新角色（lockOrganizationForActor，不信任请求进锁前的旧角色）
	 * → 按 data.export / data.clear / organization.delete 判权。返回目标组织 ID。
	 */
	private async authorizeOrganizationRequest(
		tx: Tx,
		userId: string,
		type: DataRequestType,
		domain: Extract<DataRequestDomain, { scope: "ORGANIZATION" }>,
	): Promise<string> {
		// 锁内重读：等待锁期间可能已被降权 / 移除（404）或角色值非法（403）
		const role = await lockOrganizationForActor(tx, {
			organizationId: domain.organizationId,
			membershipId: domain.membershipId,
		});
		this.assertOrganizationPermission(role, requiredPermission("ORGANIZATION", type), {
			organizationId: domain.organizationId,
			userId,
		});
		return domain.organizationId;
	}

	/**
	 * 撤回（方案 §7.6）：CLEAR 直接撤；DELETION 需 DELETION 用途验证码（仅登录不算撤回）。
	 *
	 * 双域隔离（技术方案 §9.1）：个人端点只撤个人域请求、组织端点只撤当前组织的
	 * 组织域请求；跨域 / 他人 / 不存在一律 404（不泄露存在性）。
	 */
	async cancel(
		requestId: string,
		user: User,
		dto: CancelDataRequestDto,
		domain: DataRequestDomain,
	): Promise<DataRequestViewDto> {
		const request = await this.prisma.dataRequest.findUnique({
			where: { id: requestId },
		});
		// 非本人 / 跨域 / 不存在 → 同一响应，不泄露存在性（需求验收 18）
		if (
			!request ||
			request.userId !== user.id ||
			request.scope !== domain.scope
		) {
			throw new DataRequestNotFoundException();
		}
		if (
			domain.scope === "ORGANIZATION" &&
			request.organizationId !== domain.organizationId
		) {
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

		// 条件更新：仅 PENDING 可撤回——与到期执行（认领置 PROCESSING）互斥，
		// 避免把处理中的请求改成已撤回
		const cancelled = await this.prisma.$transaction(async (tx) => {
			if (request.scope === "ORGANIZATION") {
				if (!request.organizationId) {
					throw new DataRequestNotFoundException();
				}
				// 撤回权限仍按角色（§9.2）：本人须仍是该组织有效成员且具备对应权限，
				// 事务内持组织成员锁重读（不沿用创建时的旧角色）
				const membership = await tx.membership.findUnique({
					where: {
						organizationId_userId: {
							organizationId: request.organizationId,
							userId: user.id,
						},
					},
					select: { id: true },
				});
				if (!membership) {
					throw new OrganizationNotFoundException();
				}
				const role = await lockOrganizationForActor(tx, {
					organizationId: request.organizationId,
					membershipId: membership.id,
				});
				this.assertOrganizationPermission(
					role,
					requiredPermission("ORGANIZATION", request.type as DataRequestType),
					{ organizationId: request.organizationId, userId: user.id },
				);
			}
			const updated = await tx.dataRequest.updateMany({
				where: { id: requestId, status: "PENDING" },
				data: { status: "CANCELLED" },
			});
			if (updated.count === 0) {
				throw new DataRequestNotCancellableException();
			}
			await this.recordOrganizationAudit(
				tx,
				request.scope,
				request.type,
				"cancel",
				requestId,
				{
					userId: user.id,
					organizationId: request.organizationId,
					extraDetail: { reason: "REQUESTER_CANCELLED" },
				},
			);
			return tx.dataRequest.findUniqueOrThrow({ where: { id: requestId } });
		});
		this.logger.log(
			`[data-request] cancelled scope=${cancelled.scope} type=${cancelled.type} id=${cancelled.id} userId=${user.id}`,
		);
		return this.toView(cancelled);
	}

	// ─────────────────────────────────────────────────────────
	// 读时惰性推进 + 锁判定（方案 §3.1 决策一 + 技术方案 §9.3 单次查询合并）
	//
	// 每个请求**至多 1 条** data_requests 查询：
	// - 组织上下文端点：advanceAndResolveCombinedLock 用**一条合并查询**
	//   （个人域注销 ∪ 当前组织清空/删除）同时得出推进候选与两把锁的判定依据；
	// - 未挂组织锁守卫的端点：advanceAndResolvePersonalLock 一次个人域单查。
	// ─────────────────────────────────────────────────────────

	/**
	 * 个人账号锁守卫的读时推进 + 锁判定（技术方案 §9.1–§9.3）。
	 *
	 * 单次查询口径：`scope = PERSONAL`、`type = DELETION`、
	 * `status ∈ ACTIVE_STATUSES`——**只看本人名下的个人域注销请求**，
	 * 既不查询也不拦截任何组织域请求（同组织其他成员完全不受影响）。
	 *
	 * 返回：
	 * - `userDeleted`：到期注销已物理删除 User（守卫据此让同请求返回 401）；
	 * - `lock`：非白名单端点的锁判定（ACCOUNT_PENDING_DELETION）；
	 * - `lockSubject`：触发锁的请求（供守卫给出准确文案）。
	 */
	async advanceAndResolvePersonalLock(
		userId: string,
		options: { skipLock: boolean; method: string },
	): Promise<{
		userDeleted: boolean;
		lock: PersonalLockResolution;
		lockSubject: { scope: string; type: string } | null;
	}> {
		const now = new Date();
		// 单次查询：同时取回锁判定与到期推进所需字段（至多 1 条 data_requests 查询）
		const activeRows = await this.prisma.dataRequest.findMany({
			where: {
				userId,
				scope: "PERSONAL",
				type: "DELETION",
				status: { in: ACTIVE_STATUSES as string[] },
			},
			orderBy: { requestedAt: "asc" },
			select: LOCK_ROW_SELECT,
		});

		const noLock = {
			userDeleted: false,
			lock: null,
			lockSubject: null,
		} as const;
		if (activeRows.length === 0) {
			return noLock;
		}

		let remaining = activeRows;
		const dueCandidate =
			activeRows.find(
				(row) => row.status === "PENDING" || row.status === "FAILED",
			) ?? null;

		if (dueCandidate && resolveAdvance(dueCandidate, now) === "advance") {
			try {
				const outcome = await this.executeCleanup(dueCandidate, now);
				if (outcome === "user-deleted") {
					return { userDeleted: true, lock: null, lockSubject: null };
				}
				if (outcome !== "skipped") {
					// 已终结（COMPLETED / 系统作废）：从当次活跃集合移除。
					// skipped = 被并发认领：请求仍在进行中，按库内最新状态保留
					remaining = activeRows.filter((row) => row.id !== dueCandidate.id);
				}
			} catch (error) {
				remaining = await this.handlePersonalAdvanceFailure(
					dueCandidate,
					error,
					userId,
					remaining,
				);
			}
		}

		if (options.skipLock) {
			return noLock;
		}

		// activeRows 按 requestedAt ASC 排序，末尾即最新活跃请求（与原 desc findFirst 等价）
		const latestActive = remaining[remaining.length - 1] ?? null;
		return {
			userDeleted: false,
			lock: resolvePersonalLock(latestActive),
			lockSubject: latestActive
				? { scope: latestActive.scope, type: latestActive.type }
				: null,
		};
	}

	/**
	 * 双锁合并的读时推进 + 锁判定（技术方案 §9.3；组织上下文端点的唯一入口）。
	 *
	 * **1 条合并查询**：个人域注销（`scope=PERSONAL`、`type=DELETION`、`userId=本人`）
	 * ∪ 当前组织清空/删除（`scope=ORGANIZATION`、`organizationId=当前组织`、
	 * `type ∈ {CLEAR, DELETION}`），`status ∈ ACTIVE_STATUSES`——一次查询同时得出
	 * 两把锁的推进候选与判定依据（不再出现「个人锁 1 条 + 组织锁 1 条」的固定 2 条）。
	 *
	 * 判定顺序：先个人（删号 → 401 / 账号注销锁），再组织（删组 → 404 / 组织数据锁）。
	 * 两把锁**互不误判**：个人锁只看本人名下个人域请求，组织锁只看当前组织。
	 */
	async advanceAndResolveCombinedLock(
		actor: { userId: string; organizationId: string },
		options: { method: string },
	): Promise<{
		userDeleted: boolean;
		personalLock: PersonalLockResolution;
		organizationDeleted: boolean;
		organizationLock: OrganizationLockResolution;
		personalLockSubject: { scope: string; type: string } | null;
		organizationLockSubject: { scope: string; type: string } | null;
		organizationLockSummary: { active: boolean; type: string | null };
	}> {
		const now = new Date();
		// 合并查询：个人域注销 ∪ 当前组织清空/删除（至多 1 条 data_requests 查询）
		const activeRows = await this.prisma.dataRequest.findMany({
			where: {
				status: { in: ACTIVE_STATUSES as string[] },
				OR: [
					{ scope: "PERSONAL", userId: actor.userId, type: "DELETION" },
					{
						scope: "ORGANIZATION",
						organizationId: actor.organizationId,
						type: { in: ["CLEAR", "DELETION"] },
					},
				],
			},
			orderBy: { requestedAt: "asc" },
			select: LOCK_ROW_SELECT,
		});

		let personalRows = activeRows.filter((row) => row.scope === "PERSONAL");
		let organizationRows = activeRows.filter((row) => row.scope === "ORGANIZATION");

		// 1. 个人注销候选优先推进（物理删号 → 守卫据此让同次请求 401）
		const personalDue =
			personalRows.find(
				(row) => row.status === "PENDING" || row.status === "FAILED",
			) ?? null;
		if (personalDue && resolveAdvance(personalDue, now) === "advance") {
			try {
				const outcome = await this.executeCleanup(personalDue, now);
				if (outcome === "user-deleted") {
					return {
						userDeleted: true,
						personalLock: null,
						organizationDeleted: false,
						organizationLock: null,
						personalLockSubject: null,
						organizationLockSubject: null,
						organizationLockSummary: { active: false, type: null },
					};
				}
				if (outcome !== "skipped") {
					personalRows = personalRows.filter((row) => row.id !== personalDue.id);
				}
			} catch (error) {
				personalRows = await this.handlePersonalAdvanceFailure(
					personalDue,
					error,
					actor.userId,
					personalRows,
				);
			}
		}

		// 2. 组织锁候选推进（组织已删 → 守卫据此 404）
		const organizationDue =
			organizationRows.find(
				(row) => row.status === "PENDING" || row.status === "FAILED",
			) ?? null;
		if (organizationDue && resolveAdvance(organizationDue, now) === "advance") {
			try {
				const outcome = await this.executeCleanup(organizationDue, now);
				if (organizationDue.type === "DELETION" && outcome === "completed") {
					// 组织已删（含成员关系 / 邀请 / 设置 / 审计）：后续一律 404
					return {
						userDeleted: false,
						personalLock: null,
						organizationDeleted: true,
						organizationLock: null,
						personalLockSubject: null,
						organizationLockSubject: null,
						organizationLockSummary: { active: false, type: null },
					};
				}
				if (outcome !== "skipped") {
					organizationRows = organizationRows.filter(
						(row) => row.id !== organizationDue.id,
					);
				}
			} catch (error) {
				organizationRows = await this.handleOrganizationAdvanceFailure(
					organizationDue,
					error,
					actor.organizationId,
					organizationRows,
				);
			}
		}

		// activeRows 按 requestedAt ASC 排序，末尾即最新活跃请求（与原 desc findFirst 等价）
		const latestPersonal = personalRows[personalRows.length - 1] ?? null;
		const latestOrganization = organizationRows[organizationRows.length - 1] ?? null;
		return {
			userDeleted: false,
			personalLock: resolvePersonalLock(latestPersonal),
			organizationDeleted: false,
			organizationLock: resolveOrganizationLock(
				latestOrganization,
				options.method,
			),
			personalLockSubject: latestPersonal
				? { scope: latestPersonal.scope, type: latestPersonal.type }
				: null,
			organizationLockSubject: latestOrganization
				? { scope: latestOrganization.scope, type: latestOrganization.type }
				: null,
			// 组织锁摘要（推进后的真实状态）：供当前组织视图复用，消除第 3 次查库
			organizationLockSummary: {
				active: latestOrganization !== null,
				type: latestOrganization?.type ?? null,
			},
		};
	}

	/**
	 * 个人注销推进失败后的处置（读时惰性推进）：
	 * - 唯一 Owner 阻塞 → 请求由系统作废（CANCELLED，账号锁随之解除；用户转移所有权
	 *   或删除组织后可重新申请）。不置 FAILED——FAILED 不可撤回，会把账号锁死在
	 *   无法转移所有权的死局；
	 * - 其他失败 → 整体回滚置 FAILED（锁保持，残留数据不当作正常账本），下次读时重试。
	 */
	private async handlePersonalAdvanceFailure(
		dueCandidate: ActiveRequestRow,
		error: unknown,
		userId: string,
		remaining: ActiveRequestRow[],
	): Promise<ActiveRequestRow[]> {
		if (error instanceof DataRequestLastOwnerRequiredException) {
			await this.prisma.dataRequest
				.updateMany({
					where: {
						id: dueCandidate.id,
						status: { in: ["PENDING", "FAILED"] },
					},
					data: { status: "CANCELLED" },
				})
				.catch(() => undefined);
			this.logger.warn(
				`[data-request] 个人注销到期作废（已成为某组织唯一所有者） id=${dueCandidate.id} userId=${userId}`,
			);
			return remaining.filter((row) => row.id !== dueCandidate.id);
		}
		// 条件更新：不覆盖并发已认领（PROCESSING）或已终结的行
		await this.prisma.dataRequest
			.updateMany({
				where: {
					id: dueCandidate.id,
					status: { in: ["PENDING", "FAILED"] },
				},
				data: { status: "FAILED" },
			})
			.catch(() => undefined);
		this.logger.warn(
			`[data-request] 个人注销清理 FAILED id=${dueCandidate.id} userId=${userId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return remaining.map((row) =>
			row.id === dueCandidate.id ? { ...row, status: "FAILED" } : row,
		);
	}

	/**
	 * 组织锁推进失败后的处置（读时惰性推进）：整体回滚 → FAILED（锁保持，残留数据
	 * 不当作正常账本）；下次读时重试。条件更新：不覆盖并发已认领或已终结的行。
	 */
	private async handleOrganizationAdvanceFailure(
		dueCandidate: ActiveRequestRow,
		error: unknown,
		organizationId: string,
		remaining: ActiveRequestRow[],
	): Promise<ActiveRequestRow[]> {
		await this.prisma.dataRequest
			.updateMany({
				where: {
					id: dueCandidate.id,
					status: { in: ["PENDING", "FAILED"] },
				},
				data: { status: "FAILED" },
			})
			.catch(() => undefined);
		this.logger.warn(
			`[data-request] 组织清理 FAILED scope=${dueCandidate.scope} type=${dueCandidate.type} id=${dueCandidate.id} organizationId=${organizationId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return remaining.map((row) =>
			row.id === dueCandidate.id ? { ...row, status: "FAILED" } : row,
		);
	}

	/**
	 * 到期清理：条件认领（PENDING/FAILED → PROCESSING，0 行即幂等退出）→ 按 scope 分派
	 * → 个人注销删除账号 / 组织请求 COMPLETED（发起人资格失效则为系统作废 CANCELLED）。
	 * 清理与状态流转同事务；导出临时文件在事务提交后才删除（回滚时文件与链接保持一致）。
	 */
	private async executeCleanup(
		request: ActiveRequestRow,
		now: Date,
	): Promise<CleanupOutcome> {
		const dueRequest: DueRequest = {
			id: request.id,
			userId: request.userId,
			scope: request.scope,
			organizationId: request.organizationId,
			type: request.type,
		};
		let result: CleanupResult;
		if (request.scope === "ORGANIZATION") {
			if (!request.organizationId) {
				throw new Error(
					`[data-request] 组织域到期请求缺少 organizationId id=${request.id}（DB CHECK 应已拒绝）`,
				);
			}
			const organizationId = request.organizationId;
			result = await this.prisma.$transaction(
				(tx) =>
					executeOrganizationRequest(
						tx,
						{ ...dueRequest, organizationId },
						{ now, audit: this.auditService },
					),
				CLEANUP_TX_OPTIONS,
			);
		} else if (request.scope === "PERSONAL") {
			result = await this.prisma.$transaction(
				(tx) => executePersonalDeletion(tx, dueRequest, { now }),
				CLEANUP_TX_OPTIONS,
			);
		} else {
			// 未知 scope：fail-closed（置 FAILED 待人工排查，不猜测清理范围）
			throw new Error(
				`[data-request] 未知 scope=${request.scope} id=${request.id}`,
			);
		}
		await this.unlinkExportFiles(result.exportFilesToDelete);
		if (result.outcome !== "skipped") {
			this.logger.log(
				`[data-request] ${result.outcome} scope=${request.scope} type=${request.type} id=${request.id} userId=${request.userId} rows=${JSON.stringify(result.stats)}`,
			);
		}
		return result.outcome;
	}

	// ─────────────────────────────────────────────────────────
	// 导出（同步生成 + 下载）
	// ─────────────────────────────────────────────────────────

	/**
	 * 下载（方案 §7.7）：本人 + EXPORT COMPLETED + 24h 内；过期/文件缺失 → 410。
	 *
	 * 双域隔离与实时重验（技术方案 §9.2 / DATA-02.5）：
	 * - 个人端点只受理 scope = PERSONAL 的请求；组织端点只受理 scope = ORGANIZATION
	 *   且 organizationId 绑定当前组织的请求；跨域 / 跨组织一律 404（不泄露存在性）；
	 * - 组织导出下载者必须**仍是该组织 ACTIVE 成员且角色具备 data.export**：
	 *   降权为 Operator / Viewer → 403 PERMISSION_DENIED（权限守卫，权限点丢失）；
	 *   被移出组织（DISABLED）→ 404 ORGANIZATION_NOT_FOUND（组织上下文不可达）；
	 *   切错组织（组织绑定不符）→ 404 DATA_REQUEST_NOT_FOUND。
	 *   绝不可凭旧 id 偷下组织账本；
	 * - 请求者校验：只能下载本人发起的导出。
	 */
	async loadDownload(
		requestId: string,
		userId: string,
		domain: DataRequestDomain,
	): Promise<{ buffer: Buffer; filename: string }> {
		const request = await this.prisma.dataRequest.findUnique({
			where: { id: requestId },
		});
		if (
			!request ||
			request.userId !== userId ||
			request.type !== "EXPORT" ||
			request.status !== "COMPLETED" ||
			request.scope !== domain.scope
		) {
			throw new DataRequestNotFoundException();
		}
		if (domain.scope === "ORGANIZATION") {
			// 组织绑定校验：切错 X-Organization-Id 一律 404
			if (request.organizationId !== domain.organizationId) {
				throw new DataRequestNotFoundException();
			}
			// 实时成员资格与权限复验（降权 / 移除后立即失效）
			if (
				!(await this.canDownloadOrganizationExport(
					request.organizationId,
					userId,
				))
			) {
				throw new DataRequestNotFoundException();
			}
		}
		if (
			!request.fileUrl ||
			!request.downloadExpiresAt ||
			request.downloadExpiresAt.getTime() <= Date.now()
		) {
			throw new DownloadExpiredException();
		}
		// 文件名白名单（同函数校验）：只接受 createExportSync 生成的裸 `${uuid}.zip`——
		// 库内值即使被篡改，也解析不到导出目录之外的任何路径
		const fileUrl = request.fileUrl;
		if (!EXPORT_FILENAME_PATTERN.test(fileUrl)) {
			throw new DownloadExpiredException();
		}

		// 顺带惰性清理本人其他过期临时文件（链接已关闭，失败仅 warn）
		void this.purgeExpiredFiles(userId).catch(() => undefined);

		try {
			const buffer = await readFile(join(this.exportDir, fileUrl));
			return {
				buffer,
				filename: `fxplanner-export-${request.requestedAt.toISOString().slice(0, 10)}.zip`,
			};
		} catch {
			throw new DownloadExpiredException();
		}
	}

	/** 组织导出下载资格：下载者仍是当前组织 ACTIVE 成员且角色具备 data.export */
	private async canDownloadOrganizationExport(
		organizationId: string | null,
		userId: string,
	): Promise<boolean> {
		if (!organizationId) return false;
		const membership = await this.prisma.membership.findUnique({
			where: { organizationId_userId: { organizationId, userId } },
			select: { role: true, status: true },
		});
		return (
			membership?.status === "ACTIVE" &&
			isOrganizationRole(membership.role) &&
			can(membership.role, "data.export")
		);
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

	/** 组织域判权（集中策略 can；取不到权限点一律拒绝），拒绝时尽力写 DENIED 审计 */
	private assertOrganizationPermission(
		role: OrganizationRole,
		permission: Permission | null,
		actor: { organizationId: string; userId: string },
	): void {
		if (permission && can(role, permission)) return;
		// 纯读拒绝场景的独立 DENIED 审计（尽力而为：审计异常不掩盖 403）
		void recordDeniedAuditBestEffort(this.auditService, this.logger, {
			actor,
			role,
			required: permission ?? "data.export",
			requestId: null,
		});
		throw new PermissionDeniedException();
	}

	/** 组织域请求的同事务审计留痕（个人域不属于任何组织，不留痕） */
	private async recordOrganizationAudit(
		tx: Tx,
		scope: string,
		type: string,
		verb: DataRequestAuditVerb,
		requestId: string,
		context: {
			userId: string;
			organizationId: string | null;
			extraDetail?: Record<string, unknown>;
		},
	): Promise<void> {
		const organizationId = context.organizationId;
		if (scope !== "ORGANIZATION" || !organizationId) return;
		const action = auditActionOf("ORGANIZATION", type as DataRequestType, verb);
		if (!action) return;
		await this.auditService.recordInTx(tx, {
			organizationId,
			actorUserId: context.userId,
			actorType: "USER",
			action,
			targetType: "data_request",
			targetId: requestId,
			result: "SUCCESS",
			detail: { scope, type, ...context.extraDetail },
		});
	}

	/** 清空确认页数量（方案 §7.4 六项）；口径 = 清空 / 导出同一账本作用域 */
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
		scope: OrganizationLedgerScope,
	): Promise<ImpactTotalsDto> {
		const accounts = await db.account.count({ where: scope });
		const transactions = await db.transaction.count({ where: scope });
		const initialHoldings = await db.initialHolding.count({ where: scope });
		const plans = await db.plan.count({ where: scope });
		const usageRecords = await db.usageRecord.count({ where: scope });
		const corrections = await db.correction.count({ where: scope });
		return {
			accounts,
			transactions,
			initialHoldings,
			plans,
			usageRecords,
			corrections,
		};
	}

	/**
	 * 提交 CLEAR/DELETION 时失效**同域**可下载导出链接并删除临时文件：
	 * 个人域按本人（scope = PERSONAL），组织域按组织（任何成员的组织导出，unlink 失败仅 warn）
	 */
	private async expireDownloadableExports(
		tx: Tx,
		target: {
			userId: string;
			scope: DataRequestScope;
			organizationId: string | null;
		},
		now: Date,
	): Promise<void> {
		const domainWhere: Prisma.DataRequestWhereInput =
			target.scope === "ORGANIZATION"
				? { scope: "ORGANIZATION", organizationId: target.organizationId }
				: { scope: "PERSONAL", userId: target.userId };
		const downloadable = await tx.dataRequest.findMany({
			where: {
				type: "EXPORT",
				status: "COMPLETED",
				downloadExpiresAt: { gt: now },
				...domainWhere,
			},
			select: { id: true, fileUrl: true },
		});
		if (downloadable.length === 0) return;
		await tx.dataRequest.updateMany({
			where: { id: { in: downloadable.map((r) => r.id) } },
			data: { downloadExpiresAt: now },
		});
		for (const item of downloadable) {
			await this.unlinkExportFile(item.fileUrl);
		}
	}

	/**
	 * 删除导出临时文件（best effort）。文件名白名单（同函数校验）：只接受裸 `${uuid}.zip`，
	 * 形态不合法的库内值不参与任何路径；unlink 失败仅 warn（链接已关闭）。
	 */
	private async unlinkExportFile(fileUrl: string | null): Promise<void> {
		if (!fileUrl) return;
		const filename = fileUrl;
		if (!EXPORT_FILENAME_PATTERN.test(filename)) {
			this.logger.warn(
				`[data-request] 导出文件名形态非法，拒绝删除: ${JSON.stringify(filename)}`,
			);
			return;
		}
		await unlink(join(this.exportDir, filename)).catch((error: unknown) => {
			this.logger.warn(
				`[data-request] 导出临时文件删除失败（链接已关闭，忽略）: ${filename}: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}

	/** 事务提交后批量删除导出临时文件（best effort） */
	private async unlinkExportFiles(fileUrls: readonly string[]): Promise<void> {
		for (const fileUrl of fileUrls) {
			await this.unlinkExportFile(fileUrl);
		}
	}

	/**
	 * EXPORT 同步生成：查数据 → CSV/ZIP → 落盘 → COMPLETED（fileUrl 存文件名）。
	 * 个人域只打包个人数据；组织域打包当前组织账本并同事务留痕审计。
	 */
	private async createExportSync(
		tx: Tx,
		userId: string,
		scope: DataRequestScope,
		organizationId: string | null,
		challengeId: string,
		now: Date,
	): Promise<DataRequestViewDto> {
		const zip =
			scope === "ORGANIZATION"
				? await buildOrganizationExportArchive(
						await this.collectOrganizationExportData(tx, organizationId!),
					)
				: await buildPersonalExportArchive(
						await this.collectPersonalExportData(tx, userId),
					);

		// 先落盘再建行：行创建失败回滚并清理文件；文件名用随机 UUID（不依赖行 id）
		await mkdir(this.exportDir, { recursive: true });
		const filename = `${randomUUID()}.zip`;
		await writeFile(join(this.exportDir, filename), zip);

		let created;
		try {
			created = await tx.dataRequest.create({
				data: {
					userId,
					scope,
					organizationId,
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
			// 组织导出：同事务留痕（审计失败 → 行与文件一并回滚 / 清理）
			await this.recordOrganizationAudit(tx, scope, "EXPORT", "create", created.id, {
				userId,
				organizationId,
			});
		} catch (error) {
			await unlink(join(this.exportDir, filename)).catch(() => undefined);
			throw error;
		}
		this.logger.log(
			`[data-request] EXPORT COMPLETED scope=${scope} id=${created.id} userId=${userId} bytes=${zip.length}`,
		);
		return this.toView(created);
	}

	/**
	 * 个人导出数据收集（需求 DATA-01）：账号资料、个人展示偏好、所属组织成员摘要、
	 * 个人会话元数据、条款同意、个人数据请求。**不读取任何账本表**——组织账本的
	 * 交易 / 持仓 / 批次 / 计划 / 使用 / 更正一律不进入个人导出包。
	 */
	private async collectPersonalExportData(
		tx: Tx,
		userId: string,
	): Promise<PersonalExportBundleData> {
		const [user, settings, memberships, conversations, termsConsents, dataRequests] =
			await Promise.all([
				tx.user.findUnique({
					where: { id: userId },
					select: { id: true, email: true, name: true, createdAt: true },
				}),
				tx.userSettings.findUnique({
					where: { userId },
					select: { locale: true, region: true },
				}),
				tx.membership.findMany({
					where: { userId },
					orderBy: { joinedAt: "asc" },
					select: {
						organizationId: true,
						role: true,
						status: true,
						joinedAt: true,
						organization: { select: { name: true } },
					},
				}),
				tx.aiConversation.findMany({
					where: { userId },
					orderBy: { createdAt: "asc" },
					select: { id: true, title: true, createdAt: true, lastMessageAt: true },
				}),
				tx.termsConsent.findMany({
					where: { userId },
					orderBy: { consentedAt: "asc" },
				}),
				tx.dataRequest.findMany({
					where: { userId, scope: "PERSONAL" },
					orderBy: { requestedAt: "asc" },
				}),
			]);
		return {
			generatedAt: new Date(),
			profile: {
				id: userId,
				email: user?.email ?? null,
				name: user?.name ?? null,
				createdAt: user?.createdAt ?? new Date(),
			},
			preferences: settings
				? { locale: settings.locale, region: settings.region }
				: null,
			organizations: memberships.map((row) => ({
				organizationId: row.organizationId,
				organizationName: row.organization.name,
				role: row.role,
				status: row.status,
				joinedAt: row.joinedAt,
			})),
			conversations: conversations.map((row) => ({
				id: row.id,
				title: row.title,
				createdAt: row.createdAt,
				lastMessageAt: row.lastMessageAt,
			})),
			termsConsents: termsConsents.map((row) => ({
				id: row.id,
				termsVersion: row.termsVersion,
				consentType: row.consentType,
				consentedAt: row.consentedAt,
			})),
			dataRequests: dataRequests.map(toExportDataRequestRow),
		};
	}

	/**
	 * 组织导出数据收集：当前组织的完整账本与报告（作用域 = organizationLedgerScope，
	 * 与影响确认 / 清空 / 删除同一口径）+ 本组织的数据请求。不含任何成员的个人数据
	 * （条款同意、个人展示偏好、个人会话均不进入组织导出包）。
	 */
	private async collectOrganizationExportData(
		tx: Tx,
		organizationId: string,
	): Promise<OrganizationExportBundleData> {
		const [organization, settingsRow, preferences, scope] = await Promise.all([
			tx.organization.findUniqueOrThrow({
				where: { id: organizationId },
				select: { id: true, name: true, createdAt: true },
			}),
			tx.organizationSettings.findUnique({ where: { organizationId } }),
			resolveOrganizationPreferences(tx, organizationId),
			organizationLedgerScope(tx, organizationId),
		]);
		const settings: ExportSettingsRow | null = settingsRow
			? {
					baseCurrency: settingsRow.baseCurrency,
					prepPreference: settingsRow.prepPreference,
					reminderEnabled: settingsRow.reminderEnabled,
					ledgerStartedAt: settingsRow.ledgerStartedAt,
					createdAt: settingsRow.createdAt,
					updatedAt: settingsRow.updatedAt,
				}
			: preferences
				? {
						// 兼容窗口回落：偏好值取自默认组织创建者的个人设置（无组织设置行，时间戳留空）
						baseCurrency: preferences.baseCurrency,
						prepPreference: preferences.prepPreference,
						reminderEnabled: preferences.reminderEnabled,
						ledgerStartedAt: preferences.ledgerStartedAt,
						createdAt: null,
						updatedAt: null,
					}
				: null;
		// PlanAllocation/UsageLotAllocation 为裸外键（无 relation）：先查作用域内 plan/usage id 再 in 查询
		const [ownPlans, ownUsages] = await Promise.all([
			tx.plan.findMany({ where: scope, select: { id: true } }),
			tx.usageRecord.findMany({ where: scope, select: { id: true } }),
		]);
		const planIdFilter = { in: ownPlans.map((p) => p.id) };
		const usageIdFilter = { in: ownUsages.map((u) => u.id) };
		const [initialHoldings, transactions, accounts, plans, planAllocations, usageRecords, usageLotAllocations, corrections, dataRequests] =
			await Promise.all([
				tx.initialHolding.findMany({
					where: scope,
					orderBy: { confirmedAt: "asc" },
				}),
				tx.transaction.findMany({
					where: scope,
					orderBy: { transactedAt: "asc" },
				}),
				tx.account.findMany({ where: scope, orderBy: { currencyCode: "asc" } }),
				tx.plan.findMany({ where: scope, orderBy: { createdAt: "asc" } }),
				tx.planAllocation.findMany({
					where: { planId: planIdFilter },
					orderBy: { createdAt: "asc" },
				}),
				tx.usageRecord.findMany({
					where: scope,
					orderBy: { usedAt: "asc" },
				}),
				tx.usageLotAllocation.findMany({
					where: { usageId: usageIdFilter },
					orderBy: { createdAt: "asc" },
				}),
				tx.correction.findMany({ where: scope, orderBy: { createdAt: "asc" } }),
				tx.dataRequest.findMany({
					where: { organizationId, scope: "ORGANIZATION" },
					orderBy: { requestedAt: "asc" },
				}),
			]);

		return {
			generatedAt: new Date(),
			organization,
			settings,
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
			dataRequests: dataRequests.map(toExportDataRequestRow),
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
			await this.unlinkExportFile(item.fileUrl);
		}
		if (expired.length > 0) {
			this.logger.log(
				`[data-request] purged ${expired.length} expired export file(s) userId=${userId}`,
			);
		}
	}

	/** 请求行 → 展示视图（方案 §7.3：映射/撤回可行性/下载入口由纯函数判定） */
	private toView(request: RequestViewSource): DataRequestViewDto {
		const cancelResolution = resolveCancel(request);
		return {
			id: request.id,
			type: request.type as DataRequestType,
			scope: request.scope as DataRequestScope,
			organizationId: request.organizationId,
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
