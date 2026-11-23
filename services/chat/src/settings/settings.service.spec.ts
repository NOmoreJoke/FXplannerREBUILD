import type { HttpException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { SettingsService } from "./settings.service";

const T0 = new Date("2026-08-01T00:00:00.000Z");

const settingsRow = {
	region: "CN",
	locale: "zh-CN",
	baseCurrency: "CNY",
	prepPreference: "balanced",
	reminderEnabled: true,
	ledgerStartedAt: T0,
	user: { email: "user@example.com" },
};

function createPrismaMock() {
	const userSettings = {
		findUnique: vi.fn(),
		update: vi.fn(),
	};
	// W18 组织偏好读取：默认 null（组织设置未迁 → 回落 UserSettings 原值）
	const organizationSettings = {
		findUnique: vi.fn().mockResolvedValue(null),
	};
	return { userSettings, organizationSettings };
}

function errorOf(action: () => Promise<unknown>) {
	return action().then(
		() => {
			throw new Error("expected HttpException but action resolved");
		},
		(error: unknown) => {
			const httpError = error as HttpException;
			return {
				status: httpError.getStatus(),
				body: httpError.getResponse() as { code: string; message: string },
			};
		},
	);
}

describe("SettingsService", () => {
	let prisma: ReturnType<typeof createPrismaMock>;
	let service: SettingsService;

	beforeEach(() => {
		prisma = createPrismaMock();
		service = new SettingsService(prisma as unknown as PrismaService);
	});

	describe("getSettings", () => {
		it("未建账 → 409 ONBOARDING_NOT_COMPLETED", async () => {
			prisma.userSettings.findUnique.mockResolvedValue(null);

			const { status, body } = await errorOf(() => service.getSettings({ userId: "u1", organizationId: "org-test" }));

			expect(status).toBe(409);
			expect(body.code).toBe("ONBOARDING_NOT_COMPLETED");
		});

		it("已建账：返回完整视图（含 user.email 与只读 baseCurrency）", async () => {
			prisma.userSettings.findUnique.mockResolvedValue(settingsRow);

			const view = await service.getSettings({ userId: "u1", organizationId: "org-test" });

			expect(view).toEqual({
				email: "user@example.com",
				region: "CN",
				locale: "zh-CN",
				baseCurrency: "CNY",
				prepPreference: "balanced",
				reminderEnabled: true,
				ledgerStartedAt: T0,
			});
		});
	});

	describe("updateSettings", () => {
		it("全空入参 → 400 SETTINGS_UPDATE_EMPTY（含 baseCurrency 的请求剥后为空，同一防线）", async () => {
			const { status, body } = await errorOf(() =>
				service.updateSettings("u1", {}),
			);

			expect(status).toBe(400);
			expect(body.code).toBe("SETTINGS_UPDATE_EMPTY");
			expect(prisma.userSettings.update).not.toHaveBeenCalled();
		});

		it("四字段更新：data 只含白名单字段，绝不含 baseCurrency", async () => {
			prisma.userSettings.update.mockResolvedValue(settingsRow);
			prisma.userSettings.findUnique.mockResolvedValue(settingsRow);

			await service.updateSettings("u1", {
				region: "HK",
				locale: "en",
				prepPreference: "cautious",
				reminderEnabled: false,
			});

			const [arg] = prisma.userSettings.update.mock.calls[0];
			expect(arg.where).toEqual({ userId: "u1" });
			expect(arg.data).toEqual({
				region: "HK",
				locale: "en",
				prepPreference: "cautious",
				reminderEnabled: false,
			});
			expect("baseCurrency" in arg.data).toBe(false);
		});

		it("部分字段更新：未提供的字段不出现在 data（不覆盖）", async () => {
			prisma.userSettings.update.mockResolvedValue(settingsRow);
			prisma.userSettings.findUnique.mockResolvedValue(settingsRow);

			await service.updateSettings("u1", { reminderEnabled: false });

			const [arg] = prisma.userSettings.update.mock.calls[0];
			expect(arg.data).toEqual({ reminderEnabled: false });
		});

		it("更新成功后返回完整视图（同 getSettings 形状）", async () => {
			const updated = {
				...settingsRow,
				locale: "en",
				user: { email: "u@e.com" },
			};
			prisma.userSettings.update.mockResolvedValue(updated);
			prisma.userSettings.findUnique.mockResolvedValue(updated);

			const view = await service.updateSettings("u1", { locale: "en" });

			expect(view.locale).toBe("en");
			expect(view.email).toBe("u@e.com");
			expect(view.baseCurrency).toBe("CNY");
		});

		it("记录不存在（P2025）→ 409 ONBOARDING_NOT_COMPLETED", async () => {
			prisma.userSettings.update.mockRejectedValue(
				Object.assign(new Error("Record to update not found"), {
					code: "P2025",
				}),
			);

			const { status, body } = await errorOf(() =>
				service.updateSettings("u1", { locale: "en" }),
			);

			expect(status).toBe(409);
			expect(body.code).toBe("ONBOARDING_NOT_COMPLETED");
		});

		it("非 P2025 的更新错误原样抛出", async () => {
			prisma.userSettings.update.mockRejectedValue(
				new Error("connection refused"),
			);

			await expect(
				service.updateSettings("u1", { locale: "en" }),
			).rejects.toThrow("connection refused");
		});
	});
});
