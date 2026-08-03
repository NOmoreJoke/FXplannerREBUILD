/**
 * 统一测试入口（替代分散的 test 命令）
 *
 * 用法：
 *   bun run test                  # 交互式多选（空格选择，回车确认，a=全量）
 *   bun run test all              # 全量
 *   bun run test api e2e          # 指定套件（可多选，免交互）
 *
 * 套件与目录约定一一对应：
 *   unit         后端单元      services/chat/src/**\/*.spec.ts
 *   api          后端接口      services/chat/test/api/
 *   integration  后端集成      services/chat/test/integration/
 *   infra        后端基础设施  services/chat/test/prisma.spec.ts
 *   web          前端单元      clients/chat-web（vitest）
 *   e2e          端到端        e2e/modules/（Playwright）
 *   scripts      工具链        scripts/__tests__/（bun:test）
 */

import { spawnSync } from 'child_process';
import { join } from 'path';
import readline from 'readline';

const ROOT = join(import.meta.dir, '..');

interface Suite {
  key: string;
  label: string;
  cmd: string[];
  cwd: string;
}

const SUITES: Suite[] = [
  { key: 'unit', label: '后端单元（src/*.spec.ts）', cmd: ['bunx', 'vitest', 'run', 'src/'], cwd: 'services/chat' },
  { key: 'api', label: '后端接口（test/api）', cmd: ['bunx', 'vitest', 'run', 'test/api/'], cwd: 'services/chat' },
  { key: 'integration', label: '后端集成（test/integration）', cmd: ['bunx', 'vitest', 'run', 'test/integration/'], cwd: 'services/chat' },
  { key: 'infra', label: '后端基础设施（prisma.spec）', cmd: ['bunx', 'vitest', 'run', 'test/prisma.spec.ts'], cwd: 'services/chat' },
  { key: 'web', label: '前端单元（chat-web）', cmd: ['bun', 'run', 'test'], cwd: 'clients/chat-web' },
  { key: 'e2e', label: 'E2E（Playwright）', cmd: ['bunx', 'playwright', 'test', 'e2e/modules', '--reporter=line'], cwd: '.' },
  { key: 'scripts', label: '工具链（scripts/__tests__）', cmd: ['bun', 'test', 'scripts/__tests__/'], cwd: '.' },
];

function runSuite(s: Suite): boolean {
  console.log(`\n━━━ ${s.label} ━━━`);
  const r = spawnSync(s.cmd[0], s.cmd.slice(1), {
    cwd: join(ROOT, s.cwd),
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  return r.status === 0;
}

/** 交互式多选：数字/逗号选择，a=全量，回车确认 */
async function pickSuites(): Promise<Suite[]> {
  console.log('🧪 选择要跑的测试套件（多选，逗号分隔；a=全量）：\n');
  SUITES.forEach((s, i) => console.log(`  ${i + 1}. ${s.label}`));
  console.log('  a. 全量\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) =>
    rl.question('输入选择 [a]：', (ans) => resolve(ans.trim() || 'a')),
  );
  rl.close();

  if (answer === 'a' || answer === 'all') return SUITES;

  const indexes = answer
    .split(/[,，\s]+/)
    .map((s) => Number(s) - 1)
    .filter((i) => i >= 0 && i < SUITES.length);

  if (indexes.length === 0) {
    console.error('❌ 无效选择');
    process.exit(1);
  }
  return [...new Set(indexes)].map((i) => SUITES[i]);
}

async function main() {
  const args = process.argv.slice(2);
  let selected: Suite[];

  if (args.length === 0) {
    // 无参数：TTY 下交互多选；非 TTY（CI）默认全量
    selected = process.stdin.isTTY ? await pickSuites() : SUITES;
  } else if (args.includes('all')) {
    selected = SUITES;
  } else {
    const unknown = args.filter((a) => !SUITES.some((s) => s.key === a));
    if (unknown.length > 0) {
      console.error(`❌ 未知套件: ${unknown.join(', ')}（可选：${SUITES.map((s) => s.key).join(' / ')} / all）`);
      process.exit(1);
    }
    selected = SUITES.filter((s) => args.includes(s.key));
  }

  console.log(`\n将执行 ${selected.length} 个套件: ${selected.map((s) => s.key).join(', ')}`);

  const results: Array<{ key: string; ok: boolean }> = [];
  for (const s of selected) {
    results.push({ key: s.key, ok: runSuite(s) });
  }

  console.log('\n━━━ 汇总 ━━━');
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.key}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n❌ ${failed.length} 个套件失败`);
    process.exit(1);
  }
  console.log('\n🎉 全部通过');
}

main();
