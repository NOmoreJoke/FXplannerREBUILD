/**
 * 临时重现脚本：直接调用 AccountService.detail/ledger 定位 500（跑完即删）
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { PrismaService } from "../../src/prisma/prisma.service";
import { AccountService } from "../../src/account/account.service";

async function main() {
	const prisma = new PrismaService();
	await prisma.$connect();
	const service = new AccountService(prisma);

	// 用数据库里真实持有 HKD 账户的用户
	const hkAccount = await prisma.account.findFirst({
		where: { currencyCode: "HKD" },
	});
	if (!hkAccount) throw new Error("no HKD account");
	const scope = {
		userId: hkAccount.createdById ?? "repro-user",
		organizationId: hkAccount.organizationId,
	};
	console.log("organizationId =", scope.organizationId);

	for (const [name, fn] of [
		["detail", () => service.detail(scope, "HKD")],
		["ledger", () => service.ledger(scope, "HKD")],
		["list", () => service.list(scope)],
	] as const) {
		try {
			const result = await fn();
			console.log(`✅ ${name} OK:`, JSON.stringify(result).slice(0, 300));
		} catch (error) {
			console.error(`❌ ${name} FAILED:`, error);
		}
	}

	await prisma.$disconnect();
}

main();
