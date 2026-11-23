import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import type { Plan, PlanAllocation, PlanInstallment } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
import {
	compatReadWhere,
	type ReadScope,
} from "../authorization/organization-scope";
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
		// 候选集（SQL 粗筛，三条并集保证不漏当前成员的未读）：
		//   a. 行主本人未读；b. 落在近 30 天窗口内；c. 当前成员从未读过
		// 此前直接用行内 reminders.read_at 过滤窗口——行主读过一条 30 天前的提醒后，
		// 同组织其他成员的这条未读提醒会被 SQL 直接滤掉（评审 I-11）。
		const candidates = await this.prisma.reminder.findMany({
			where: {
				AND: [
					compatReadWhere(scope),
					{
						OR: [
							{ readAt: null },
							{ scheduledFor: { gte: readWindowStart } },
							{ NOT: { readStates: { some: { userId: scope.userId } } } },
						],
					},
				],
			},
			orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
		});

		// 当前成员的已读时刻：成员级 ReminderRead 优先；无成员级行时回落行内 readAt
		// （仅行主本人语义——他人行的 readAt 不构成我的已读态）
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
		const effectiveReadAt = (row: { id: string; userId: string; readAt: Date | null }) =>
			memberReadAtByReminder.get(row.id) ??
			(row.userId === scope.userId ? row.readAt : null);
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
	 * 单条已读（POST /api/reminders/:id/read，§7.2）：归属双保险（id + userId）；
	 * 行不存在或非本人均 404 REMINDER_NOT_FOUND；重复调用幂等返回既有 readAt。
	 */
	async markRead(userId: string, id: string): Promise<ReminderReadResultDto> {
		const row = await this.prisma.reminder.findFirst({
			where: { id, userId },
		});
		if (!row) {
			throw new ReminderNotFoundException();
		}
		if (row.readAt !== null) {
			return { id: row.id, readAt: row.readAt.toISOString() };
		}
		const updated = await this.prisma.reminder.update({
			where: { id },
			data: { readAt: new Date() },
		});
		return {
			id: updated.id,
			readAt: (updated.readAt ?? new Date()).toISOString(),
		};
	}

	/**
	 * 全部已读（POST /api/reminders/read-all，§7.3）：updateMany 仅命中当前用户未读行，
	 * 天然幂等（再次调用 updatedCount = 0）。
	 */
	async markAllRead(userId: string): Promise<ReminderReadAllResultDto> {
		const result = await this.prisma.reminder.updateMany({
			where: { userId, readAt: null },
			data: { readAt: new Date() },
		});
		return { updatedCount: result.count };
	}

	// ────────────────────────── 懒生成（§4.2/§4.3）──────────────────────────

	/**
	 * 读时懒生成：读 ACTIVE 计划 + 分配 + 排期 + 已有行（批量）→ 纯函数判定（只算今天）
	 * → createMany skipDuplicates（唯一键 [userId, dedupKey, scheduledFor] 兜底并发）。
	 *
	 * 评审 I-11：只在**当前组织作用域**内生成（compatReadWhere）。此前按 userId 全量
	 * 扫描该用户在所有组织的 ACTIVE 计划并写入 organizationId IS NULL 的行——读任意
	 * 组织都会把别的组织的提醒以 NULL 行生成出来。现在行的 userId/organizationId
	 * 随父计划（父子同组织，§5.3.2）；同组织任一成员的读取都会为其组织补齐到期提醒。
	 */
	private async generateDueReminders(scope: ReadScope): Promise<void> {
		const plans = await this.prisma.plan.findMany({
			where: { status: "ACTIVE", ...compatReadWhere(scope) },
		});
		if (plans.length === 0) {
			return;
		}
		const ownerByPlanId = new Map(
			plans.map((plan) => [
				plan.id,
				{ userId: plan.userId, organizationId: plan.organizationId },
			]),
		);
		const planIds = plans.map((plan) => plan.id);
		const [allocations, installments, existingRows] = await Promise.all([
			this.prisma.planAllocation.findMany({
				where: { planId: { in: planIds } },
			}),
			this.prisma.planInstallment.findMany({
				where: { planId: { in: planIds } },
				orderBy: { seq: "asc" },
			}),
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
			// 行的归属随父计划：userId = 计划创建者（唯一键与存量一致，保证幂等），
			// organizationId = 计划所属组织（NULL 计划保持 NULL，仅在默认组织可见）
			data: drafts.map((draft) => {
				const owner = ownerByPlanId.get(draft.planId);
				return {
					...draft,
					userId: owner?.userId ?? scope.userId,
					organizationId: owner?.organizationId ?? null,
				};
			}),
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
				where: { id: { in: planIds }, ...compatReadWhere(scope) },
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
