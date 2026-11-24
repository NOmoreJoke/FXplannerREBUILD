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

/** 组织偏好解析所需的 mock（评审 I-08/I-10）：组织设置 → 所有者 → 所有者默认组织 → 所有者个人设置 */
type SettingsRowLike = Record<string, unknown>;

function createPrismaMock(overrides: {
	organizationSettings?: SettingsRowLike | null;
	ownerUserId?: string | null;
	ownerDefaultOrganizationId?: string | null;
	/** 各用户的个人设置行（按 userId）；缺省用户 = 无个人设置行 */
	userSettingsByUserId?: Record<string, SettingsRowLike>;
} = {}) {
	const userSettings = {
		// 同一个 mock 服务两种查询：请求者本人的展示字段 / 兼容回落时所有者的设置
		findUnique: vi.fn((args: { where: { userId: string } }) =>
			Promise.resolve(overrides.userSettingsByUserId?.[args.where.userId] ?? null),
		),
		update: vi.fn(),
	};
	const organizationSettings = {
		findUnique: vi.fn().mockResolvedValue(overrides.organizationSettings ?? null),
	};
	const membership = {
		// 组织的活跃 Owner（resolveOrganizationPreferences）
		findFirst: vi.fn(() =>
			Promise.resolve(overrides.ownerUserId ? { userId: overrides.ownerUserId } : null),
		),
	};
	// 所有者的默认组织（resolveDefaultOrganizationId 走原生 SQL，评审 R2-I03）：
	// 无 = 该用户尚未创建任何组织
	const $queryRaw = vi.fn(async () =>
		overrides.ownerDefaultOrganizationId
			? [{ organizationId: overrides.ownerDefaultOrganizationId }]
			: [],
	);
	return { userSettings, organizationSettings, membership, $queryRaw };
}

const orgSettingsRow = {
	baseCurrency: "CNY",
	prepPreference: "balanced",
	reminderEnabled: true,
	ledgerStartedAt: T0,
};

const legacySettingsRow = {
	baseCurrency: "USD",
	prepPreference: "cautious",
	reminderEnabled: false,
	ledgerStartedAt: T0,
};

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

	/** 以指定组织偏好形态构造服务（默认：无组织设置、无所有者 = 未建账） */
	function buildService(overrides: Parameters<typeof createPrismaMock>[0] = {}) {
		const mock = createPrismaMock(overrides);
		return {
			mock,
			instance: new SettingsService(mock as unknown as PrismaService),
		};
	}

	beforeEach(() => {
		prisma = createPrismaMock();
		service = new SettingsService(prisma as unknown as PrismaService);
	});

	describe("getSettings（组织偏好 + 个人展示字段；评审 I-08/I-10）", () => {
		const SCOPE = { userId: "u1", organizationId: "org-test" };
		/** 守卫链已解析的登录身份（控制器传入，服务不再查 user） */
		const IDENTITY = { email: "user@example.com" };

		it("未建账（无组织设置、无所有者个人设置）→ 409 ONBOARDING_NOT_COMPLETED", async () => {
			const { instance } = buildService();

			const { status, body } = await errorOf(() => instance.getSettings(SCOPE, IDENTITY));

			expect(status).toBe(409);
			expect(body.code).toBe("ONBOARDING_NOT_COMPLETED");
		});

		it("组织设置存在：受邀成员（无个人设置行）读到组织偏好 + 展示默认值，不再 409", async () => {
			const { instance } = buildService({ organizationSettings: orgSettingsRow });

			const view = await instance.getSettings(SCOPE, IDENTITY);

			expect(view).toEqual({
				email: "user@example.com", // 守卫链解析的登录身份，不依赖个人设置行
				region: "CN",
				locale: "zh-CN",
				baseCurrency: "CNY",
				prepPreference: "balanced",
				reminderEnabled: true,
				ledgerStartedAt: T0,
			});
		});

		it("个人展示字段取请求者本人设置，组织偏好不被个人行覆盖；email 取登录身份", async () => {
			const { instance } = buildService({
				organizationSettings: orgSettingsRow,
				userSettingsByUserId: {
					u1: {
						region: "HK",
						locale: "en",
						baseCurrency: "JPY", // 个人行里的旧本位币不得带出
					},
				},
			});

			const view = await instance.getSettings(SCOPE, { email: "login@example.com" });

			expect(view).toMatchObject({
				email: "login@example.com",
				region: "HK",
				locale: "en",
				baseCurrency: "CNY",
			});
		});

		it("兼容回落：默认组织的所有者尚无 OrganizationSettings 时，以其个人设置代表组织偏好", async () => {
			const { instance } = buildService({
				ownerUserId: "u1",
				ownerDefaultOrganizationId: "org-test",
				userSettingsByUserId: {
					u1: { ...legacySettingsRow, region: "CN", locale: "zh-CN", user: { email: "user@example.com" } },
				},
			});

			const view = await instance.getSettings(SCOPE, IDENTITY);

			expect(view).toEqual({
				email: "user@example.com",
				region: "CN",
				locale: "zh-CN",
				baseCurrency: "USD",
				prepPreference: "cautious",
				reminderEnabled: false,
				ledgerStartedAt: T0,
			});
		});

		it("兼容回落读的是组织所有者的设置：受邀成员在仅所有者建过账的组织里同样可读", async () => {
			const { instance } = buildService({
				ownerUserId: "owner",
				ownerDefaultOrganizationId: "org-test",
				userSettingsByUserId: { owner: legacySettingsRow },
			});

			const view = await instance.getSettings(
				{ userId: "member", organizationId: "org-test" },
				{ email: null },
			);

			expect(view.baseCurrency).toBe("USD");
			expect(view.email).toBeNull();
		});

		it("非默认组织绝不回落：创建者个人已建账，但其新建组织仍判未建账（评审 I-08）", async () => {
			const { instance } = buildService({
				ownerUserId: "u1",
				ownerDefaultOrganizationId: "org-default", // 创建者的默认组织是另一个
				userSettingsByUserId: {
					u1: { ...legacySettingsRow, region: "CN", locale: "zh-CN", user: { email: "user@example.com" } },
				},
			});

			const { status, body } = await errorOf(() => instance.getSettings(SCOPE, IDENTITY));

			expect(status).toBe(409);
			expect(body.code).toBe("ONBOARDING_NOT_COMPLETED");
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
