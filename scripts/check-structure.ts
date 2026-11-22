import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const errors: string[] = [];

function exists(relPath: string): boolean {
  return fs.existsSync(path.join(ROOT, relPath));
}

// 1. 测试产物与报告只允许落在 e2e/test-results，禁止污染根目录、services、clients
const forbiddenArtifacts = [
  'test-results',
  'playwright-report',
  'services/test-results',
  'services/playwright-report',
  'services/chat/test-results',
  'services/chat/playwright-report',
  'clients/test-results',
  'clients/playwright-report',
  'clients/chat-web/test-results',
  'clients/chat-web/playwright-report',
];
for (const relPath of forbiddenArtifacts) {
  if (exists(relPath)) {
    errors.push(
      `[目录红线] 禁止存在 "${relPath}"，测试产物只允许放入 e2e/test-results/（提交前请清理）。`,
    );
  }
}

// 2. services/chat 下禁止出现越界目录
for (const badDir of ['services/chat/changes', 'services/chat/clients']) {
  if (exists(badDir)) {
    errors.push(`[目录红线] 禁止在 services/chat 下创建 "${badDir}"。`);
  }
}

// 3. packages/* 每个子包必须包含 README.md（说明职责、边界与独立成包理由）
const packagesDir = path.join(ROOT, 'packages');
if (fs.existsSync(packagesDir)) {
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const readmePath = path.join(packagesDir, entry.name, 'README.md');
    if (!fs.existsSync(readmePath)) {
      errors.push(
        `[包边界红线] packages/${entry.name} 缺少 README.md（需写明做什么 / 不做什么 / 为何独立成包）。`,
      );
    }
  }
}

// 4. 前端生成的 OpenAPI 类型文件必须保留自动生成头，防止手写覆盖
const schemaGenPath = path.join(ROOT, 'clients/chat-web/lib/api/schema.gen.ts');
if (fs.existsSync(schemaGenPath)) {
  const firstLine = fs.readFileSync(schemaGenPath, 'utf8').split('\n')[0] ?? '';
  if (!firstLine.includes('generate:api')) {
    errors.push(
      '[契约红线] clients/chat-web/lib/api/schema.gen.ts 缺少自动生成头标记，请通过 bun run --cwd clients/chat-web generate:api 生成而非手改。',
    );
  }
}

if (errors.length > 0) {
  console.error('❌ 仓库结构守卫检查未通过：\n' + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}

console.log('✅ 仓库结构守卫检查通过（产物边界 / 子包 README / OpenAPI 契约头）');
