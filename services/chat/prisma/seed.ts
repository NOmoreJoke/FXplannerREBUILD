import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

// 生产环境保护：禁止在生产环境运行 seed
if (process.env.NODE_ENV === 'production') {
  console.error('❌ 禁止在生产环境运行种子数据脚本');
  process.exit(1);
}

const prisma = new PrismaClient();

/**
 * 种子数据：骨架最小集
 * - 1 个演示用户
 * - 2 个示例项目（L2 示例模块数据）
 */
async function main() {
  console.log('🌱 开始种子数据...');

  // 清空现有数据（按外键依赖顺序）
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();

  // 1. 演示用户
  const demoPassword = process.env.SEED_DEMO_PASSWORD || 'demo123456';
  const passwordHash = await bcrypt.hash(demoPassword, 10);
  const user = await prisma.user.create({
    data: {
      email: 'demo@example.com',
      passwordHash,
      name: '演示用户',
    },
  });
  console.log(`  ✓ 用户: ${user.email}`);

  // 2. 示例项目
  const project1 = await prisma.project.create({
    data: {
      userId: user.id,
      name: '示例项目 A',
      description: '演示示例模块的列表与详情',
    },
  });
  const project2 = await prisma.project.create({
    data: {
      userId: user.id,
      name: '示例项目 B',
      description: null,
    },
  });
  console.log(`  ✓ 项目: ${project1.name}, ${project2.name}`);

  console.log('✅ 种子数据完成');
  console.log(`  - 用户: 1 个（${user.email} / ${demoPassword}）`);
  console.log(`  - 项目: 2 个`);
}

main()
  .catch((e) => {
    console.error('❌ 种子数据失败:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
