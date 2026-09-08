import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { CURRENCIES } from "@fxplanner-new/money";

// 生产环境保护：禁止在生产环境运行 seed
if (process.env.NODE_ENV === "production") {
	console.error("❌ 禁止在生产环境运行种子数据脚本");
	process.exit(1);
}

const prisma = new PrismaClient();

/**
 * 种子数据：骨架最小集
 * - 15 个币种（从 @fxplanner-new/money 的 CURRENCIES 导入，单一事实来源；upsert 幂等）
 * - 1 个演示用户
 */
async function main() {
	console.log("🌱 开始种子数据...");

	for (const currency of CURRENCIES) {
		await prisma.currency.upsert({
			where: { code: currency.code },
			create: {
				code: currency.code,
				nameZh: currency.nameZh,
				nameEn: currency.nameEn,
				decimalPlaces: currency.decimalPlaces,
				sortOrder: currency.sortOrder,
			},
			update: {
				nameZh: currency.nameZh,
				nameEn: currency.nameEn,
				decimalPlaces: currency.decimalPlaces,
				sortOrder: currency.sortOrder,
			},
		});
		console.log(
			`  ✓ 币种: ${currency.code}（${currency.nameZh}，${currency.decimalPlaces} 位小数）`,
		);
	}

	await prisma.user.deleteMany();

	const demoPassword = process.env.SEED_DEMO_PASSWORD || "demo123456";
	const passwordHash = await bcrypt.hash(demoPassword, 10);
	const user = await prisma.user.create({
		data: {
			email: "demo@example.com",
			passwordHash,
			name: "演示用户",
		},
	});

	console.log(`  ✓ 用户: ${user.email}`);
	console.log("✅ 种子数据完成");
	console.log(`  - 币种: ${CURRENCIES.length} 个`);
	console.log(`  - 用户: 1 个（${user.email} / ${demoPassword}）`);
}

main()
	.catch((e) => {
		console.error("❌ 种子数据失败:", e);
		process.exit(1);
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
