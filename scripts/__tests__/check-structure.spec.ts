import { afterEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRepositoryStructure } from '../check-structure';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const tempDirs: string[] = [];

function createTempRepoFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxplanner-structure-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'services/chat/src/auth'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages/money'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/money/README.md'), '# money\n');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/check-structure.ts'), '// ok\n');
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('checkRepositoryStructure', () => {
  it('passes against real repository root (positive proof)', () => {
    const errors = checkRepositoryStructure({ rootDir: REPO_ROOT });
    expect(errors).toEqual([]);
  });

  it('rejects non-existent target-state paths registered in AGENTS.md (I-1 negative proof)', () => {
    const baseAgentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8');
    const mutatedAgentsMd = baseAgentsMd
      .replace(
        '│  │  ├─ ai/',
        '│  │  ├─ proposal/                  # 目标态未落地目录\n│  │  ├─ ai/',
      )
      .replace(
        'check-org-scope / lint-observe',
        'check-org-scope / check-compliance-copy / lint-observe',
      )
      .replace(
        '变更文档 `changes/product-harness-agent/`',
        '变更文档 `changes/product-harness-agent/`；`clients/chat-web/components/business/collab/`',
      );

    const errors = checkRepositoryStructure({
      rootDir: REPO_ROOT,
      agentsMdContent: mutatedAgentsMd,
    });

    expect(errors.some((e) => e.includes('services/chat/src/proposal'))).toBe(true);
    expect(errors.some((e) => e.includes('check-compliance-copy'))).toBe(true);
    expect(errors.some((e) => e.includes('clients/chat-web/components/business/collab'))).toBe(
      true,
    );
  });

  it('rejects backend modules on disk missing from AGENTS.md tree', () => {
    const root = createTempRepoFixture();
    fs.mkdirSync(path.join(root, 'services/chat/src/rogue'), { recursive: true });

    const minimalAgentsMd = [
      '```',
      '├─ services/chat/',
      '│  └─ src/',
      '│     └─ auth/',
      '├─ packages/',
      '├─ packages/money/',
      '├─ scripts/                         # 工程脚本（check-structure）',
      '```',
    ].join('\n');

    const errors = checkRepositoryStructure({ rootDir: root, agentsMdContent: minimalAgentsMd });
    expect(errors.some((e) => e.includes('services/chat/src/rogue'))).toBe(true);
  });

  it('rejects self-hosted font binary without matching OFL.txt and accepts valid OFL.txt (I-2)', () => {
    const root = createTempRepoFixture();
    const fontsDir = path.join(root, 'clients/chat-web/public/fonts');
    fs.mkdirSync(fontsDir, { recursive: true });
    const fontBytes = Buffer.from('mock-woff2-binary');
    fs.writeFileSync(path.join(fontsDir, 'sample.woff2'), fontBytes);

    const minimalAgentsMd = [
      '```',
      '├─ services/chat/',
      '│  └─ src/',
      '│     └─ auth/',
      '├─ packages/money/',
      '├─ scripts/                         # 工程脚本（check-structure）',
      '```',
    ].join('\n');

    const missingLicenseErrors = checkRepositoryStructure({
      rootDir: root,
      agentsMdContent: minimalAgentsMd,
    });
    expect(missingLicenseErrors.some((e) => e.includes('[字体许可证红线]'))).toBe(true);

    const sha = crypto.createHash('sha256').update(fontBytes).digest('hex');
    fs.writeFileSync(
      path.join(fontsDir, 'OFL.txt'),
      `SHA-256: ${sha}\nCopyright 2017 The Authors\nSIL Open Font License Version 1.1\n`,
    );

    const validErrors = checkRepositoryStructure({
      rootDir: root,
      agentsMdContent: minimalAgentsMd,
    });
    expect(validErrors).toEqual([]);
  });
});
