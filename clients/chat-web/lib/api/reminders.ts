import { apiClient } from "@/lib/api/client";
import type {
	ReminderReadAllResult,
	ReminderReadResult,
	RemindersView,
} from "@/lib/api/contract";

/**
 * 站内提醒封装（reminders 技术方案 §8 数据层）：三端点封装，类型走 generate:api。
 *
 * GET /reminders 内置读时懒生成（后端 §4.2）：首页铃铛/今日提醒区与提醒中心页
 * 共用本接口与同一个 react-query Key，首页打开即触发生成，无需独立接口。
 */
export const remindersApi = {
	/**
	 * 查询提醒列表（GET /reminders）；未建账 → 409 ONBOARDING_NOT_COMPLETED。
	 * 幂等读（生成有唯一键防重），重复请求无副作用。
	 */
	async list(): Promise<RemindersView> {
		return apiClient<RemindersView>("/reminders", {
			method: "GET",
		});
	},

	/**
	 * 单条已读（POST /reminders/:id/read）；行不存在或非本人 → 404
	 * REMINDER_NOT_FOUND；重复调用幂等返回既有 readAt。
	 */
	async markRead(id: string): Promise<ReminderReadResult> {
		return apiClient<ReminderReadResult>(`/reminders/${id}/read`, {
			method: "POST",
		});
	},

	/** 全部已读（POST /reminders/read-all）；天然幂等（重复调用 updatedCount=0）。 */
	async markAllRead(): Promise<ReminderReadAllResult> {
		return apiClient<ReminderReadAllResult>("/reminders/read-all", {
			method: "POST",
		});
	},
};
