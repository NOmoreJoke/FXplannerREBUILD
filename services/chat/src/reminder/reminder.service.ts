import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import type { Plan, PlanAllocation, PlanInstallment } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
import { orgWhere, type ReadScope } from "../authorization/organization-scope";
import { resolveOrganizationPreferences } from "../organization/organization-preferences";
import type {
	ReminderItemDto,
	ReminderMatterDto,
	ReminderReadAllResultDto,
	ReminderReadResultDto,
	RemindersViewDto,
} from "./dto/reminder.dto";
import {
	addUtc8Days,
	computeDueDrafts,
	computeMattersAt,
	computePlanGap,
	utcPlus8Midnight,
	type ReminderPlanSnapshot,
	type ReminderRowSnapshot,
} from "./reminder-rules";

/** 提醒行不存在或不属于本人（§7.4：越权与不存在同响应，不泄露存在性） */
export class ReminderNotFoundException extends HttpException {
	constructor() {
		super(
			{ code: "REMINDER_NOT_FOUND", message: "提醒不存在" },
			HttpStatus.NOT_FOUND,
		);
	}
}

/** 列表服务端兑底条数（§7.1：未读全量 + 已读近 30 天，limit 100 防御） */
const REMINDER_LIST_LIMIT = 100;
/** 已读行的返回窗口（业务日）：scheduledFor 距今 30 天内 */
const READ_WINDOW_DAYS = 30;

@Injectable()
export class ReminderService {
	private readonly logger = new Logger(ReminderService.name);

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/**
	 * 提醒列表（GET /api/reminders，§4.2/§6 时序）：
	 * ① 未建账 409（以**当前组织**的偏好为准——评审 I-10：此前读请求者本人的
	 *    UserSettings，受邀加入已建账组织的成员没有个人设置行，读提醒必 409）
	 * ② 组织开关开启 → 读时懒生成「今天」应存在的行（§4.2 挂载点；失败降级跳过，§11）
	 * ③ 查询未读全量 + 已读近 30 天（scheduledFor 倒序，limit 100）——已读态按
	 *    **当前成员**判定（LEDGER-03）：行主读过不替其他成员清除未读（评审 I-11）
	 * ④ 逐行派生 matters：非 ACTIVE 计划行、planId 缺失行、matters 为空的行不返回（§4.5）。
	 */
	async list(scope: ReadScope): Promise<RemindersViewDto> {
		const preferences = await resolveOrganizationPreferences(
			this.prisma,
			scope.organizationId,
		);
		if (!preferences) {
			throw new OnboardingNotCompletedException();
		}

		if (preferences.reminderEnabled) {
			// 生成失败兜底（§11）：漏一轮无业务损失，下次请求重算；列表本身失败才走错误态
			try {
				await this.generateDueReminders(scope);
			} catch (error) {
				this.logger.warn(
					`generateDueReminders failed organizationId=${scope.organizationId} error=${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		const readWindowStart = addUtc8Days(
			utcPlus8Midnight(new Date()),
			-READ_WINDOW_DAYS,
		);
		// 候选集（SQL 粗筛，两条并集保证不漏当前成员的未读）：
		//   a. 落在近 30 天窗口内；b. 当前成员从未读过
		// W30（MIG-F）：Reminder 已无共享的 readAt 列，已读态只走成员级
		// ReminderRead(reminderId, userId)——行内共享读态不存在，行主一读不再
		// 替其他成员滤掉未读提醒。
		const candidates = await this.prisma.reminder.findMany({
			where: {
				AND: [
					orgWhere(scope),
					{
						OR: [
							{ scheduledFor: { gte: readWindowStart } },
							{ NOT: { readStates: { some: { userId: scope.userId } } } },
						],
					},
				],
			},
			orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
		});

		// 当前成员的已读时刻：只认成员级 ReminderRead（一名成员已读不影响他人未读态）
		const memberReads = await this.prisma.reminderRead.findMany({
			where: {
				userId: scope.userId,
				reminderId: { in: candidates.map((row) => row.id) },
			},
			select: { reminderId: true, readAt: true },
		});
		const memberReadAtByReminder = new Map(
			memberReads.map((read) => [read.reminderId, read.readAt]),
		);
		const effectiveReadAt = (row: { id: string }) =>
			memberReadAtByReminder.get(row.id) ?? null;
		// 窗口语义不变：「未读全量 + 已读近 30 天」，近 30 天以**提醒日 scheduledFor** 计
		// （与原 SQL 口径一致），已读态取当前成员的
		const rows = candidates
			.filter((row) => {
				const readAt = effectiveReadAt(row);
				return readAt === null || row.scheduledFor >= readWindowStart;
			})
			.slice(0, REMINDER_LIST_LIMIT)
			.map((row) => ({ ...row, readAt: effectiveReadAt(row) }));

		const items = await this.toItems(scope, rows);
		return {
			items,
			unreadCount: items.filter((item) => item.readAt === null).length,
		};
	}

	/**
	 * 单条已读（POST /api/reminders/:id/read，§7.2 + LEDGER-03 成员级已读）：
	 *
	 * 目标提醒按「当前组织作用域 + id」校验（orgWhere(scope)）：
	 * 不存在或跨组织一律 404 REMINDER_NOT_FOUND（不泄露存在性；未受邀 / 已被移除
	 * 的成员由 OrganizationContextGuard 在进入服务前即返回 404）。
	 *
	 * 已读态落在**成员级** ReminderRead(reminderId, userId)：一名成员标已读
	 * **严禁**写入或修改任何共享读态（否则一人一读即替同组织全体成员清除未读，
	 * 评审 I-11 的复发）。重复调用幂等：既有成员级已读行直接返回其
	 * readAt，不改写时刻。
	 */
	async markRead(scope: ReadScope, id: string): Promise<ReminderReadResultDto> {
		const row = await this.prisma.reminder.findFirst({
			where: { id, ...orgWhere(scope) },
			select: { id: true },
		});
		if (!row) {
			throw new ReminderNotFoundException();
		}
		const existing = await this.prisma.reminderRead.findUnique({
			where: {
				reminderId_userId: { reminderId: id, userId: scope.userId },
			},
			select: { readAt: true },
		});
		if (existing) {
			return { id, readAt: existing.readAt.toISOString() };
		}
		const now = new Date();
		const upserted = await this.prisma.reminderRead.upsert({
			where: {
				reminderId_userId: { reminderId: id, userId: scope.userId },
			},
			update: { readAt: now },
			create: { reminderId: id, userId: scope.userId, readAt: now },
			select: { readAt: true },
		});
		return { id, readAt: upserted.readAt.toISOString() };
	}

	/**
	 * 全部已读（POST /api/reminders/read-all，§7.3 + LEDGER-03）：
	 *
	 * 目标集合 = 当前组织作用域（orgWhere(scope)）内**当前成员尚未读过**的
	 * 提醒行：成员级 ReminderRead 无对应行即未读。
	 *
	 * 落库只写当前成员自己的 ReminderRead（事务内 createMany + skipDuplicates：
	 * 并发重复调用不撞唯一键），**严禁**修改任何共享读态。天然幂等：
	 * 再次调用无可插入行 → updatedCount = 0。
	 */
	async markAllRead(scope: ReadScope): Promise<ReminderReadAllResultDto> {
		const candidates = await this.prisma.reminder.findMany({
			where: { ...orgWhere(scope) },
			select: { id: true },
		});
		if (candidates.length === 0) {
			return { updatedCount: 0 };
		}
		const memberReads = await this.prisma.reminderRead.findMany({
			where: {
				userId: scope.userId,
				reminderId: { in: candidates.map((row) => row.id) },
			},
			select: { reminderId: true },
		});
		const readReminderIds = new Set(
			memberReads.map((read) => read.reminderId),
		);
		const pending = candidates.filter(
			(row) => !readReminderIds.has(row.id),
		);
		if (pending.length === 0) {
			return { updatedCount: 0 };
		}
		const now = new Date();
		const result = await this.prisma.$transaction(async (tx) =>
			tx.reminderRead.createMany({
				data: pending.map((row) => ({
					reminderId: row.id,
					userId: scope.userId,
					readAt: now,
				})),
				skipDuplicates: true,
			}),
		);
		return { updatedCount: result.count };
	}

	// ────────────────────────── 懒生成（§4.2/§4.3）──────────────────────────

	/**
	 * 读时懒生成：读 ACTIVE 计划 + 分配 + 排期 + 已有行（批量）→ 纯函数判定（只算今天）
	 * → createMany skipDuplicates（唯一键 [organizationId, dedupKey, scheduledFor] 兜底并发）。
	 *
	 * 评审 I-11：只在**当前组织作用域**内生成（orgWhere）。行的 organizationId
	 * 恒为当前组织（父子同组织，§5.3.2）；同组织任一成员的读取都会为其组织
	 * 补齐到期提醒。
	 */
	private async generateDueReminders(scope: ReadScope): Promise<void> {
		const plans = await this.prisma.plan.findMany({
			where: { status: "ACTIVE", ...orgWhere(scope) },
		});
		if (plans.length === 0) {
			return;
		}
		const planIds = plans.map((plan) => plan.id);
		const [allocations, installments, existingRows] = await Promise.all([
			this.prisma.planAllocation.findMany({
				where: { planId: { in: planIds } },
			}),
			this.prisma.planInstallment.findMany({
				where: { planId: { in: planIds } },
				orderBy: { seq: "asc" },
			}),
			// @org-scope-exempt: 已按当前组织作用域筛选 ACTIVE 父计划 planIds，批量查已有提醒防重
			this.prisma.reminder.findMany({
				where: { planId: { in: planIds } },
				select: { planId: true, type: true, scheduledFor: true },
			}),
		]);

		const allocationByPlan = new Map(
			allocations.map((allocation) => [allocation.planId, allocation]),
		);
		const installmentsByPlan = new Map<string, PlanInstallment[]>();
		for (const installment of installments) {
			const list = installmentsByPlan.get(installment.planId) ?? [];
			list.push(installment);
			installmentsByPlan.set(installment.planId, list);
		}

		const drafts = computeDueDrafts({
			plans: plans.map((plan) =>
				this.toPlanSnapshot(
					plan,
					allocationByPlan.get(plan.id) ?? null,
					installmentsByPlan.get(plan.id) ?? [],
				),
			),
			today: new Date(),
			existingRows: existingRows as ReminderRowSnapshot[],
		});
		if (drafts.length === 0) {
			return;
		}
		await this.prisma.reminder.createMany({
			// 行的归属：organizationId = **当前组织**（W25：严格写入 scope.organizationId，
			// 遵守 @@unique([organizationId, dedupKey, scheduledFor])——同组织多成员
			// 读取同一计划时命中同一唯一键，createMany skipDuplicates 天然去重）。
			data: drafts.map((draft) => ({
				...draft,
				organizationId: scope.organizationId,
			})),
			skipDuplicates: true,
		});
	}

	/** 计划行 + 分配行 + 排期行 → 纯函数快照（字段拷贝，不含模型实例） */
	private toPlanSnapshot(
		plan: Plan,
		allocation: PlanAllocation | null,
		installments: PlanInstallment[],
	): ReminderPlanSnapshot {
		return {
			planId: plan.id,
			name: plan.name,
			status: plan.status,
			targetCurrency: plan.targetCurrency,
			targetAmount: plan.targetAmount,
			latestPrepDate: plan.latestPrepDate,
			expectUseDate: plan.expectUseDate,
			installments: installments.map((installment) => ({
				seq: installment.seq,
				scheduledAt: installment.scheduledAt,
				amount: installment.amount,
			})),
			allocAmount: allocation?.amount ?? new Prisma.Decimal(0),
			usedAmount: allocation?.usedAmount ?? new Prisma.Decimal(0),
		};
	}

	// ────────────────────────── 派生与出参（§4.5/§7.1）──────────────────────────

	/** 行列表 → 出参列表：内存关联计划（裸外键先例），过滤非 ACTIVE / matters 为空的行 */
	private async toItems(
		scope: ReadScope,
		rows: Array<{
			id: string;
			planId: string | null;
			type: string;
			scheduledFor: Date;
			readAt: Date | null;
		}>,
	): Promise<ReminderItemDto[]> {
		const planIds = [
			...new Set(rows.map((row) => row.planId).filter((id): id is string => id !== null)),
		];
		if (planIds.length === 0) {
			return [];
		}
		const [plans, allocations] = await Promise.all([
			// 纵深防御（评审 N-08）：计划查询同样带组织作用域条件，不凭「id 来自已过
			// 滤的提醒行」推断可见性
			this.prisma.plan.findMany({
				where: { id: { in: planIds }, ...orgWhere(scope) },
			}),
			this.prisma.planAllocation.findMany({
				where: { planId: { in: planIds } },
			}),
		]);
		const planById = new Map(plans.map((plan) => [plan.id, plan]));
		const allocationByPlan = new Map(
			allocations.map((allocation) => [allocation.planId, allocation]),
		);
		const installments = await this.prisma.planInstallment.findMany({
			where: { planId: { in: planIds } },
			orderBy: { seq: "asc" },
		});
		const installmentsByPlan = new Map<string, PlanInstallment[]>();
		for (const installment of installments) {
			const list = installmentsByPlan.get(installment.planId) ?? [];
			list.push(installment);
			installmentsByPlan.set(installment.planId, list);
		}

		const items: ReminderItemDto[] = [];
		for (const row of rows) {
			if (row.planId === null) {
				continue; // 无法关联计划的行不返回（matters 恒空）
			}
			const plan = planById.get(row.planId);
			if (!plan || plan.status !== "ACTIVE") {
				continue; // 已完成/已取消计划停止主动提醒（08:18；行保留不删）
			}
			const snapshot = this.toPlanSnapshot(
				plan,
				allocationByPlan.get(plan.id) ?? null,
				installmentsByPlan.get(plan.id) ?? [],
			);
			// 查询态派生：参照日 = 行 scheduledFor（§4.5「不限今天」，覆盖 scheduledFor=今天的历史行）
			const matters = computeMattersAt(
				snapshot,
				utcPlus8Midnight(row.scheduledFor),
			);
			if (matters.length === 0) {
				continue; // 排期更新后无节点 / 备齐后原准备类行 → 前端无感
			}
			items.push(this.toItemDto(row, snapshot, matters));
		}
		return items;
	}

	private toItemDto(
		row: { id: string; planId: string | null; type: string; scheduledFor: Date; readAt: Date | null },
		snapshot: ReminderPlanSnapshot,
		matters: ReturnType<typeof computeMattersAt>,
	): ReminderItemDto {
		const gap = computePlanGap(snapshot);
		const gapAmount = gap.toFixed(4);
		return {
			id: row.id,
			planId: snapshot.planId,
			planName: snapshot.name,
			targetCurrency: snapshot.targetCurrency,
			scheduledFor: row.scheduledFor.toISOString(),
			readAt: row.readAt ? row.readAt.toISOString() : null,
			recordedType: row.type as ReminderItemDto["recordedType"],
			matters: matters.map<ReminderMatterDto>((matter) => ({
				kind: matter.kind,
				installmentAmount:
					matter.installmentAmount?.toFixed(4) ?? null,
				gapAmount,
				isFundsReady: gap.isZero(),
				daysOverdue: matter.daysOverdue,
			})),
		};
	}
}
