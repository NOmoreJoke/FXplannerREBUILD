import type { HttpException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditService } from "../audit/audit.service";
import type { ActorContext } from "../authorization/authorization.types";
import type { PrismaService } from "../prisma/prisma.service";
import { SettingsService } from "./settings.service";

const T0 = new Date("2026-08-01T00:00:00.000Z");

type SettingsRowLike = Record<string, unknown>;

function createPrismaMock(overrides: {
	organizationSettings?: SettingsRowLike | null;
	ownerUserId?: string | null;
	ownerDefaultOrganizationId?: string | null;
	userSettingsByUserId?: Record<string, SettingsRowLike>;
	lockedMembership?: {
		organizationId: string;
		role: string;
		status: string;
	} | null;
} = {}) {
	const userSettings = {
		findUnique: vi.fn((args: { where: { userId: string } }) =>
			Promise.resolve(overrides.userSettingsByUserId?.[args.where.userId] ?? null),
		),
		update: vi.fn(),
		updateMany: vi.fn().mockResolvedValue({ count: 0 }),
		upsert: vi.fn(
			async (args: {
				where: { userId: string };
				create: { region: string; locale: string };
				update: { region?: string; locale?: string };
			}) => {
				const existing = overrides.userSettingsByUserId?.[args.where.userId];
				return {
					region: args.update.region ?? (existing?.region as string | undefined) ?? args.create.region,
					locale: args.update.locale ?? (existing?.locale as string | undefined) ?? args.create.locale,
				};
			},
		),
	};
	const organizationSettings = {
		findUnique: vi.fn().mockResolvedValue(overrides.organizationSettings ?? null),
		upsert: vi.fn(async (args: { create: SettingsRowLike }) => args.create),
		update: vi.fn(async (args: { data: SettingsRowLike }) => ({
			...(overrides.organizationSettings ?? orgSettingsRow),
			...args.data,
		})),
	};
	const membership = {
		findFirst: vi.fn(() =>
			Promise.resolve(overrides.ownerUserId ? { userId: overrides.ownerUserId } : null),
		),
		findUnique: vi.fn().mockResolvedValue(
			overrides.lockedMembership === undefined
				? { organizationId: "org-test", role: "OWNER", status: "ACTIVE" }
				: overrides.lockedMembership,
		),
	};
	const $queryRaw = vi.fn(async () =>
		overrides.ownerDefaultOrganizationId
			? [{ organizationId: overrides.ownerDefaultOrganizationId }]
			: [],
	);
	const $executeRaw = vi.fn().mockResolvedValue(1);
	const prisma = {
		userSettings,
		organizationSettings,
		membership,
		$queryRaw,
		$executeRaw,
		$transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) =>
			cb(prisma),
		),
	};
	return prisma;
}

function createAuditMock() {
	return {
		recordInTx: vi.fn().mockResolvedValue(undefined),
		recordStandalone: vi.fn().mockResolvedValue(undefined),
	} as unknown as {
		recordInTx: ReturnType<typeof vi.fn>;
		recordStandalone: ReturnType<typeof vi.fn>;
	} & AuditService;
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

const OWNER_ACTOR: ActorContext = {
	userId: "u1",
	organizationId: "org-test",
	membershipId: "mem-1",
	role: "OWNER",
	authMethod: "USER",
	isDefaultOrganization: true,
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
	let audit: ReturnType<typeof createAuditMock>;
	let service: SettingsService;

	function buildService(overrides: Parameters<typeof createPrismaMock>[0] = {}) {
		const mock = createPrismaMock(overrides);
		const auditMock = createAuditMock();
		return {
			mock,
			auditMock,
			instance: new SettingsService(
				mock as unknown as PrismaService,
				auditMock,
			),
		};
	}

	beforeEach(() => {
		prisma = createPrismaMock({ organizationSettings: orgSettingsRow });
		audit = createAuditMock();
		service = new SettingsService(prisma as unknown as PrismaService, audit);
	});

	describe("getSettings（组织偏好 + 个人展示字段；评审 I-08/I-10）", () => {
		const SCOPE = { userId: "u1", organizationId: "org-test" };
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
				email: "user@example.com",
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
						baseCurrency: "JPY",
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
				ownerDefaultOrganizationId: "org-default",
				userSettingsByUserId: {
					u1: { ...legacySettingsRow, region: "CN", locale: "zh-CN", user: { email: "user@example.com" } },
				},
			});

			const { status, body } = await errorOf(() => instance.getSettings(SCOPE, IDENTITY));

			expect(status).toBe(409);
			expect(body.code).toBe("ONBOARDING_NOT_COMPLETED");
		});
	});

	describe("updateSettings（个人/组织分权 + 锁内复验 + 审计）", () => {
		const IDENTITY = { email: "user@example.com" };

		it("全空入参 → 400 SETTINGS_UPDATE_EMPTY（含 baseCurrency 的请求剥后为空，同一防线）", async () => {
			const { status, body } = await errorOf(() =>
				service.updateSettings(OWNER_ACTOR, {}, IDENTITY, "req-empty"),
			);

			expect(status).toBe(400);
			expect(body.code).toBe("SETTINGS_UPDATE_EMPTY");
			expect(prisma.organizationSettings.update).not.toHaveBeenCalled();
			expect(prisma.userSettings.upsert).not.toHaveBeenCalled();
		});

		it("VIEWER/OPERATOR/FINANCE 更新组织偏好 → 403 PERMISSION_DENIED + recordStandalone DENIED", async () => {
			for (const role of ["VIEWER", "OPERATOR", "FINANCE"] as const) {
				const { instance, mock, auditMock } = buildService({
					organizationSettings: orgSettingsRow,
				});
				const { status, body } = await errorOf(() =>
					instance.updateSettings(
						{ ...OWNER_ACTOR, role },
						{ prepPreference: "cautious" },
						IDENTITY,
						`req-${role}`,
					),
				);

				expect(status, role).toBe(403);
				expect(body.code).toBe("PERMISSION_DENIED");
				expect(auditMock.recordStandalone).toHaveBeenCalledWith({
					organizationId: "org-test",
					actorUserId: "u1",
					actorType: "USER",
					action: "permission.denied.settings.update",
					result: "DENIED",
					requestId: `req-${role}`,
					detail: { required: "settings.update", role },
				});
				expect(mock.$transaction).not.toHaveBeenCalled();
			}
		});

		it("锁等期间降权 → 事务中止 + recordStandalone DENIED + 403", async () => {
			const { instance, mock, auditMock } = buildService({
				organizationSettings: orgSettingsRow,
				lockedMembership: {
					organizationId: "org-test",
					role: "VIEWER",
					status: "ACTIVE",
				},
			});

			const { status, body } = await errorOf(() =>
				instance.updateSettings(
					OWNER_ACTOR,
					{ reminderEnabled: false },
					IDENTITY,
					"req-demoted",
				),
			);

			expect(status).toBe(403);
			expect(body.code).toBe("PERMISSION_DENIED");
			expect(mock.organizationSettings.update).not.toHaveBeenCalled();
			expect(auditMock.recordInTx).not.toHaveBeenCalled();
			expect(auditMock.recordStandalone).toHaveBeenCalledWith({
				organizationId: "org-test",
				actorUserId: "u1",
				actorType: "USER",
				action: "permission.denied.settings.update",
				result: "DENIED",
				requestId: "req-demoted",
				detail: { required: "settings.update", role: "VIEWER" },
			});
		});

		it("VIEWER 仅更新 region/locale → 放行写 UserSettings，不写组织设置或组织审计", async () => {
			const { instance, mock, auditMock } = buildService({
				organizationSettings: orgSettingsRow,
			});

			const view = await instance.updateSettings(
				{ ...OWNER_ACTOR, role: "VIEWER", isDefaultOrganization: false },
				{ region: "HK", locale: "en" },
				IDENTITY,
				"req-viewer-personal",
			);

			expect(view).toMatchObject({
				email: "user@example.com",
				region: "HK",
				locale: "en",
				baseCurrency: "CNY",
				prepPreference: "balanced",
			});
			expect(mock.userSettings.upsert).toHaveBeenCalledWith({
				where: { userId: "u1" },
				create: {
					userId: "u1",
					baseCurrency: "",
					region: "HK",
					locale: "en",
				},
				update: { region: "HK", locale: "en" },
				select: { region: true, locale: true },
			});
			expect(mock.organizationSettings.update).not.toHaveBeenCalled();
			expect(auditMock.recordInTx).not.toHaveBeenCalled();
		});

		it("四字段更新（默认组织）：写 OrganizationSettings + 同步本人 UserSettings 兼容列 + 同事务写审计", async () => {
			const view = await service.updateSettings(
				OWNER_ACTOR,
				{
					region: "HK",
					locale: "en",
					prepPreference: "cautious",
					reminderEnabled: false,
				},
				IDENTITY,
				"req-1",
			);

			expect(prisma.organizationSettings.update).toHaveBeenCalledWith({
				where: { organizationId: "org-test" },
				data: { prepPreference: "cautious", reminderEnabled: false },
			});
			expect(prisma.userSettings.updateMany).toHaveBeenCalledWith({
				where: { userId: "u1" },
				data: { prepPreference: "cautious", reminderEnabled: false },
			});
			const [upsertArg] = prisma.userSettings.upsert.mock.calls[0];
			expect(upsertArg.update).toEqual({ region: "HK", locale: "en" });
			expect("baseCurrency" in upsertArg.update).toBe(false);
			expect(audit.recordInTx).toHaveBeenCalledWith(
				prisma,
				expect.objectContaining({
					organizationId: "org-test",
					actorUserId: "u1",
					action: "settings.update",
					targetType: "organization_settings",
					targetId: "org-test",
					result: "SUCCESS",
					requestId: "req-1",
				}),
			);
			expect(view).toMatchObject({
				region: "HK",
				locale: "en",
				prepPreference: "cautious",
				reminderEnabled: false,
				baseCurrency: "CNY",
			});
		});

		it("非默认组织更新组织偏好：不触碰本人 UserSettings 兼容列", async () => {
			await service.updateSettings(
				{ ...OWNER_ACTOR, isDefaultOrganization: false },
				{ reminderEnabled: false },
				IDENTITY,
			);

			expect(prisma.organizationSettings.update).toHaveBeenCalledWith({
				where: { organizationId: "org-test" },
				data: { reminderEnabled: false },
			});
			expect(prisma.userSettings.updateMany).not.toHaveBeenCalled();
		});

		it("OWNER_LEGACY 组织更新组织偏好前先固化 OrganizationSettings", async () => {
			const { instance, mock } = buildService({
				organizationSettings: null,
				ownerUserId: "u1",
				ownerDefaultOrganizationId: "org-test",
				userSettingsByUserId: { u1: legacySettingsRow },
			});

			const view = await instance.updateSettings(
				OWNER_ACTOR,
				{ prepPreference: "proactive" },
				IDENTITY,
			);

			expect(mock.organizationSettings.upsert).toHaveBeenCalledTimes(1);
			expect(mock.organizationSettings.update).toHaveBeenCalledWith({
				where: { organizationId: "org-test" },
				data: { prepPreference: "proactive" },
			});
			expect(view.baseCurrency).toBe("USD");
		});

		it("未建账组织 PATCH → 409 ONBOARDING_NOT_COMPLETED", async () => {
			const { instance } = buildService();

			const { status, body } = await errorOf(() =>
				instance.updateSettings(OWNER_ACTOR, { locale: "en" }, IDENTITY),
			);

			expect(status).toBe(409);
			expect(body.code).toBe("ONBOARDING_NOT_COMPLETED");
		});
	});

	describe("getPersonalSettings / updatePersonalSettings（无组织/未建账可用）", () => {
		it("无 UserSettings 时 GET /settings/personal 返回产品默认值", async () => {
			const { instance } = buildService();

			const view = await instance.getPersonalSettings("u1", { email: "u@e.com" });

			expect(view).toEqual({
				email: "u@e.com",
				region: "CN",
				locale: "zh-CN",
			});
		});

		it("PATCH /settings/personal 全空 → 400 SETTINGS_UPDATE_EMPTY", async () => {
			const { status, body } = await errorOf(() =>
				service.updatePersonalSettings("u1", {}, { email: "u@e.com" }),
			);

			expect(status).toBe(400);
			expect(body.code).toBe("SETTINGS_UPDATE_EMPTY");
		});

		it("PATCH /settings/personal upsert 个人行且不创建 OrganizationSettings", async () => {
			const { instance, mock } = buildService();

			const view = await instance.updatePersonalSettings(
				"u1",
				{ region: "HK", locale: "en" },
				{ email: "u@e.com" },
			);

			expect(view).toEqual({ email: "u@e.com", region: "HK", locale: "en" });
			expect(mock.userSettings.upsert).toHaveBeenCalledWith({
				where: { userId: "u1" },
				create: {
					userId: "u1",
					baseCurrency: "",
					region: "HK",
					locale: "en",
				},
				update: { region: "HK", locale: "en" },
				select: { region: true, locale: true },
			});
			expect(mock.organizationSettings.upsert).not.toHaveBeenCalled();
		});

		it("个人占位行（baseCurrency=\"\"）不影响组织未建账判定（getSettings 仍 409）", async () => {
			const { instance } = buildService({
				organizationSettings: null,
				ownerUserId: "u1",
				ownerDefaultOrganizationId: "org-test",
				userSettingsByUserId: {
					u1: {
						baseCurrency: "",
						region: "HK",
						locale: "en",
						prepPreference: "balanced",
						reminderEnabled: true,
						ledgerStartedAt: null,
					},
				},
			});

			const { status, body } = await errorOf(() =>
				instance.getSettings({ userId: "u1", organizationId: "org-test" }, { email: "u@e.com" }),
			);

			expect(status).toBe(409);
			expect(body.code).toBe("ONBOARDING_NOT_COMPLETED");
		});
	});
});
