/**
 * 确保用户已完成首次设置（BE-03 防线适配）。
 *
 * 背景：plan/transaction/usage 写入口已加 409 ONBOARDING_NOT_COMPLETED 防线
 * （未建账不允许建计划/录交易/记使用）。经 API 造数的 spec 需先为本工具
 * createTestUser 产出的用户补 settings，否则造数请求一律 409。
 *
 * 直插 userSettings 而非走 POST /onboarding/complete：complete 会把
 * ledgerStartedAt 锚定为「今日 UTC+8 日初」，导致 spec 里常用的
 * 「昨天」历史日期造数撞 400「早于账本起点」；直插不设起点日（null）
 * 保持「无起点 → 跳过下界校验」的既有测试语义（report-test-helper
 * ensureSettings 同款实现，此处放 test-app 供全域复用）。
 */
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";
import type { PrismaService } from "../../src/prisma/prisma.service";

export async function ensureOnboarded(
	prisma: PrismaService,
	userId: string,
	baseCurrency = "CNY",
	ledgerStartedAt: Date | null = null,
	options: { legacyOnly?: boolean } = {},
): Promise<void> {
	await prisma.userSettings.upsert({
		where: { userId },
		update: { baseCurrency, ledgerStartedAt },
		create: {
			userId,
			baseCurrency,
			locale: "zh-CN",
			region: "CN",
			ledgerStartedAt,
		},
	});
	if (options.legacyOnly) return;
	const defaultOrganizationId = await resolveDefaultOrganizationId(
		prisma,
		userId,
	);
	if (defaultOrganizationId) {
		await prisma.organizationSettings.upsert({
			where: { organizationId: defaultOrganizationId },
			update: { baseCurrency, ledgerStartedAt },
			create: {
				organizationId: defaultOrganizationId,
				baseCurrency,
				ledgerStartedAt,
			},
		});
	}
}
