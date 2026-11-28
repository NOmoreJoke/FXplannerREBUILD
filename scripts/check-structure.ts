import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface StructureCheckOptions {
  rootDir?: string;
  agentsMdContent?: string;
}

const FONT_FILE_PATTERN = /\.(woff2?|ttf|otf)$/i;
const LICENSE_FILE_PATTERN = /^(OFL\.txt|LICENSE(\..*)?)$/i;
const BACKTICK_REPO_PATH_PATTERN =
  /`((?:clients|services|packages|scripts|e2e|design-harness|changes|docs|infra)\/[^`\s]+)`/g;
const LEGACY_DOC_ONLY_TREE_PATHS = new Set<string>(['clients/chat-web/app/(protected)/projects']);
const LEGACY_DOC_ONLY_SCRIPT_TOKENS = new Set<string>(['init']);
const GITIGNORED_ENV_PATH_PATTERN = /(?:^|\/)\.env(?:\.(?!example$)[^/]+)?$/;

function existsInRoot(rootDir: string, relPath: string): boolean {
  const normalized = relPath.replace(/\/+$/, '');
  return fs.existsSync(path.join(rootDir, normalized));
}

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]+)\}/.exec(pattern);
  if (!match) return [pattern];

  const matchStart = match.index;
  const fullMatch = match[0];
  const inner = match[1] ?? '';
  const prefix = pattern.slice(0, matchStart);
  const suffix = pattern.slice(matchStart + fullMatch.length);
  const results: string[] = [];

  for (const option of inner.split(',')) {
    const trimmed = option.trim();
    if (!trimmed) continue;
    results.push(...expandBraces(`${prefix}${trimmed}${suffix}`));
  }

  return results;
}

function listImmediateDirectories(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

function checkForbiddenArtifacts(rootDir: string, errors: string[]): void {
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
    if (existsInRoot(rootDir, relPath)) {
      errors.push(
        `[目录红线] 禁止存在 "${relPath}"，测试产物只允许放入 e2e/test-results/（提交前请清理）。`,
      );
    }
  }

  for (const badDir of ['services/chat/changes', 'services/chat/clients']) {
    if (existsInRoot(rootDir, badDir)) {
      errors.push(`[目录红线] 禁止在 services/chat 下创建 "${badDir}"。`);
    }
  }
}

function checkPackageReadmes(rootDir: string, errors: string[]): void {
  const packagesDir = path.join(rootDir, 'packages');
  for (const pkgName of listImmediateDirectories(packagesDir)) {
    const readmePath = path.join(packagesDir, pkgName, 'README.md');
    if (!fs.existsSync(readmePath)) {
      errors.push(
        `[包边界红线] packages/${pkgName} 缺少 README.md（需写明做什么 / 不做什么 / 为何独立成包）。`,
      );
    }
  }
}

function checkOpenApiSchemaHeader(rootDir: string, errors: string[]): void {
  const schemaGenPath = path.join(rootDir, 'clients/chat-web/lib/api/schema.gen.ts');
  if (!fs.existsSync(schemaGenPath)) return;

  const firstLine = fs.readFileSync(schemaGenPath, 'utf8').split('\n')[0] ?? '';
  if (!firstLine.includes('generate:api')) {
    errors.push(
      '[契约红线] clients/chat-web/lib/api/schema.gen.ts 缺少自动生成头标记，请通过 bun run --cwd clients/chat-web generate:api 生成而非手改。',
    );
  }
}

function extractTreeBlock(agentsMd: string): { block: string; startLine: number } | null {
  const lines = agentsMd.split('\n');
  let insideFence = false;
  let fenceStart = -1;
  const collected: string[] = [];

  for (const [idx, line] of lines.entries()) {
    if (line.trim() === '```') {
      if (!insideFence) {
        insideFence = true;
        fenceStart = idx;
        collected.length = 0;
        continue;
      }
      if (collected.some((item) => item.includes('├─') || item.includes('└─'))) {
        return { block: collected.join('\n'), startLine: fenceStart };
      }
      insideFence = false;
      continue;
    }

    if (insideFence) {
      collected.push(line);
    }
  }

  return null;
}

function checkAgentsMdTruthSource(rootDir: string, agentsMd: string, errors: string[]): void {
  const tree = extractTreeBlock(agentsMd);
  if (!tree) {
    errors.push('[AGENTS.md 真源红线] 未在 AGENTS.md 中找到目录树代码块。');
    return;
  }

  const seenTreePaths = new Set<string>();
  const stack: string[] = [];

  for (const rawLine of tree.block.split('\n')) {
    const match = /^([│ ]*(?:├─|└─)\s+)([^#]+?)(?:\s+#.*)?$/.exec(rawLine);
    if (!match) continue;

    const prefix = match[1] ?? '';
    const branchIdx = Math.max(prefix.indexOf('├'), prefix.indexOf('└'));
    if (branchIdx < 0) continue;

    const depth = Math.floor(branchIdx / 3);
    const namesRaw = (match[2] ?? '').trim();
    const rawNames = namesRaw.split(/\s+/).filter(Boolean);
    stack.length = depth;

    for (const rawName of rawNames) {
      const cleanName = rawName.replace(/\/+$/, '');
      const relPath = [...stack, cleanName].join('/');
      seenTreePaths.add(relPath);

      if (relPath.includes('<')) continue;
      if (relPath === 'e2e/test-results' || relPath.startsWith('e2e/test-results/')) continue;
      if (LEGACY_DOC_ONLY_TREE_PATHS.has(relPath)) continue;
      if (GITIGNORED_ENV_PATH_PATTERN.test(relPath)) continue;

      if (!existsInRoot(rootDir, relPath)) {
        errors.push(
          `[AGENTS.md 真源红线] 目录树登记的路径 "${relPath}" 在仓库中不存在（禁止提前登记目标态路径）。`,
        );
      }
    }

    if (rawNames.length === 1) {
      const onlyName = rawNames[0] ?? '';
      stack[depth] = onlyName.replace(/\/+$/, '');
    }
  }

  if (seenTreePaths.has('services/chat/src')) {
    for (const dirName of listImmediateDirectories(path.join(rootDir, 'services/chat/src'))) {
      const rel = `services/chat/src/${dirName}`;
      if (!seenTreePaths.has(rel)) {
        errors.push(`[AGENTS.md 真源红线] 后端模块 "${rel}/" 未在 AGENTS.md 目录树中登记。`);
      }
    }
  }

  if (seenTreePaths.has('packages')) {
    for (const pkgName of listImmediateDirectories(path.join(rootDir, 'packages'))) {
      const rel = `packages/${pkgName}`;
      if (!seenTreePaths.has(rel)) {
        errors.push(`[AGENTS.md 真源红线] 包目录 "${rel}/" 未在 AGENTS.md 目录树中登记。`);
      }
    }
  }

  const scriptsManifest = /^├─\s+scripts\/\s+#\s+工程脚本（([^）]+)）/m.exec(agentsMd);
  if (scriptsManifest?.[1]) {
    const declaredScripts = scriptsManifest[1]
      .split('/')
      .map((item) => item.trim())
      .filter(Boolean);

    for (const scriptToken of declaredScripts) {
      if (LEGACY_DOC_ONLY_SCRIPT_TOKENS.has(scriptToken)) continue;
      const candidates = [
        `scripts/${scriptToken}`,
        `scripts/${scriptToken}.ts`,
        `scripts/${scriptToken}.mjs`,
        `scripts/${scriptToken}.sh`,
      ];
      if (!candidates.some((candidate) => existsInRoot(rootDir, candidate))) {
        errors.push(
          `[AGENTS.md 真源红线] scripts/ 说明中登记的 "${scriptToken}" 在 scripts/ 下找不到对应文件或目录。`,
        );
      }
    }
  }

  for (const [idx, line] of agentsMd.split('\n').entries()) {
    for (const match of line.matchAll(BACKTICK_REPO_PATH_PATTERN)) {
      const rawToken = match[1] ?? '';
      const withoutLine = rawToken.replace(/:[0-9]+.*$/, '');
      for (const expanded of expandBraces(withoutLine)) {
        const cleanPath = expanded.replace(/\/+$/, '');
        if (!cleanPath || /[*<…$]/.test(cleanPath)) continue;
        if (cleanPath === 'e2e/test-results' || cleanPath.startsWith('e2e/test-results/')) continue;
        if (LEGACY_DOC_ONLY_TREE_PATHS.has(cleanPath)) continue;
        if (GITIGNORED_ENV_PATH_PATTERN.test(cleanPath)) continue;

        if (!existsInRoot(rootDir, cleanPath)) {
          errors.push(
            `[AGENTS.md 真源红线] 第 ${idx + 1} 行引用的路径 "${cleanPath}" 在仓库中不存在。`,
          );
        }
      }
    }
  }
}

function checkFontLicenses(rootDir: string, errors: string[]): void {
  const clientsDir = path.join(rootDir, 'clients');
  for (const clientName of listImmediateDirectories(clientsDir)) {
    const fontsDir = path.join(clientsDir, clientName, 'public', 'fonts');
    if (!fs.existsSync(fontsDir)) continue;

    const entries = fs.readdirSync(fontsDir, { withFileTypes: true }).filter((e) => e.isFile());
    const fontFiles = entries.filter((e) => FONT_FILE_PATTERN.test(e.name)).map((e) => e.name);
    if (fontFiles.length === 0) continue;

    const licenseFiles = entries.filter((e) => LICENSE_FILE_PATTERN.test(e.name)).map((e) => e.name);
    if (licenseFiles.length === 0) {
      errors.push(
        `[字体许可证红线] clients/${clientName}/public/fonts/ 存在自托管字体文件（${fontFiles.join(', ')}），但缺少 OFL.txt 或 LICENSE 许可证文件。`,
      );
      continue;
    }

    const primaryLicenseName = licenseFiles.includes('OFL.txt')
      ? 'OFL.txt'
      : (licenseFiles[0] ?? 'OFL.txt');
    const licenseContent = fs.readFileSync(path.join(fontsDir, primaryLicenseName), 'utf8').trim();
    if (!licenseContent || !/Copyright/i.test(licenseContent) || !/(Open Font License|LICENSE)/i.test(licenseContent)) {
      errors.push(
        `[字体许可证红线] clients/${clientName}/public/fonts/${primaryLicenseName} 缺少完整版权声明与许可证正文。`,
      );
      continue;
    }

    const shaMatch = /SHA-256:\s*([a-f0-9]{64})/i.exec(licenseContent);
    if (shaMatch?.[1] && fontFiles.length === 1 && fontFiles[0]) {
      const actualSha = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(fontsDir, fontFiles[0])))
        .digest('hex');
      if (actualSha !== shaMatch[1].toLowerCase()) {
        errors.push(
          `[字体许可证红线] clients/${clientName}/public/fonts/${primaryLicenseName} 声明的 SHA-256 (${shaMatch[1]}) 与 ${fontFiles[0]} 实际摘要 (${actualSha}) 不一致。`,
        );
      }
    }
  }
}

/**
 * 校验仓库结构、包边界、OpenAPI 契约头、AGENTS.md 路径真源与自托管字体许可证。
 */
export function checkRepositoryStructure(options: StructureCheckOptions = {}): string[] {
  const rootDir = options.rootDir ?? process.cwd();
  const errors: string[] = [];

  checkForbiddenArtifacts(rootDir, errors);
  checkPackageReadmes(rootDir, errors);
  checkOpenApiSchemaHeader(rootDir, errors);

  const agentsPath = path.join(rootDir, 'AGENTS.md');
  const agentsMdContent =
    options.agentsMdContent ?? (fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : null);
  if (agentsMdContent !== null) {
    checkAgentsMdTruthSource(rootDir, agentsMdContent, errors);
  }

  checkFontLicenses(rootDir, errors);
  return errors;
}

if (import.meta.main) {
  const useStdinAgentsMd = process.argv.includes('--stdin-agents-md');
  const agentsMdContent = useStdinAgentsMd ? fs.readFileSync(0, 'utf8') : undefined;
  const errors = checkRepositoryStructure({ agentsMdContent });

  if (errors.length > 0) {
    console.error('❌ 仓库结构守卫检查未通过：\n' + errors.map((e) => `  - ${e}`).join('\n'));
    process.exit(1);
  }

  console.log(
    '✅ 仓库结构守卫检查通过（产物边界 / 子包 README / OpenAPI 契约头 / AGENTS.md 路径真源 / 字体许可证）',
  );
}
