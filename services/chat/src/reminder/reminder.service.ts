import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import type { Plan, PlanAllocation, PlanInstallment } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
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
	 * ① 未建账 409（依赖 UserSettings.reminderEnabled，对齐 settings 先例）
	 * ② 开关开启 → 读时懒生成「今天」应存在的行（§4.2 挂载点；失败降级跳过，§11）
	 * ③ 查询未读全量 + 已读近 30 天（scheduledFor 倒序，limit 100）
	 * ④ 逐行派生 matters：非 ACTIVE 计划行、planId 缺失行、matters 为空的行不返回（§4.5）。
	 */
	async list(userId: string): Promise<RemindersViewDto> {
		const settings = await this.prisma.userSettings.findUnique({
			where: { userId },
			select: { reminderEnabled: true },
		});
		if (!settings) {
			throw new OnboardingNotCompletedException();
		}

		if (settings.reminderEnabled) {
			// 生成失败兜底（§11）：漏一轮无业务损失，下次请求重算；列表本身失败才走错误态
			try {
				await this.generateDueReminders(userId);
			} catch (error) {
				this.logger.warn(
					`generateDueReminders failed userId=${userId} error=${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		const readWindowStart = addUtc8Days(
			utcPlus8Midnight(new Date()),
			-READ_WINDOW_DAYS,
		);
		const rows = await this.prisma.reminder.findMany({
			where: {
				userId,
				OR: [{ readAt: null }, { scheduledFor: { gte: readWindowStart } }],
			},
			orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
			take: REMINDER_LIST_LIMIT,
		});

		const items = await this.toItems(rows);
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
	 */
	private async generateDueReminders(userId: string): Promise<void> {
		const plans = await this.prisma.plan.findMany({
			where: { userId, status: "ACTIVE" },
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
			this.prisma.reminder.findMany({
				where: { userId, planId: { in: planIds } },
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
			data: drafts.map((draft) => ({ ...draft, userId })),
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
			this.prisma.plan.findMany({ where: { id: { in: planIds } } }),
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
