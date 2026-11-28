import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/worktree/worktree-create.sh');

const tempRoots: Array<{ tempDir: string; repoDir: string; worktreeDir?: string }> = [];

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const entry = tempRoots.pop();
    if (!entry) continue;
    if (entry.worktreeDir && fs.existsSync(entry.repoDir)) {
      spawnSync('git', ['worktree', 'remove', '--force', entry.worktreeDir], {
        cwd: entry.repoDir,
        stdio: 'ignore',
      });
    }
    fs.rmSync(entry.tempDir, { recursive: true, force: true });
  }
});

describe('worktree dev startup isolation', () => {
  it('ensures services/chat dev script creates logs directory before tee', () => {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'services/chat/package.json'), 'utf8'),
    ) as { scripts?: { dev?: string } };

    expect(pkgJson.scripts?.dev?.startsWith('mkdir -p logs &&')).toBe(true);
  });

  it('allocates isolated WEB_PORT, API_PORT, and DEV_LOG_PORT and copies subpackage .env.local files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxp-wt-test-'));
    const repoDir = path.join(tempDir, 'repo');
    const worktreesDir = path.join(tempDir, 'worktrees');
    const worktreeDir = path.join(worktreesDir, 'wt-smoke');
    tempRoots.push({ tempDir, repoDir, worktreeDir });

    fs.mkdirSync(path.join(repoDir, 'services/chat'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'clients/chat-web'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'changes'), { recursive: true });
    fs.mkdirSync(worktreesDir, { recursive: true });

    fs.writeFileSync(path.join(repoDir, 'changes/readme.md'), '# test\n');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# temp repo\n');

    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      stdio: 'pipe',
    });
    execFileSync('git', ['config', 'user.name', 'Test User'], {
      cwd: repoDir,
      stdio: 'pipe',
    });
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });

    fs.writeFileSync(
      path.join(repoDir, '.env.local'),
      [
        'WEB_PORT=3001',
        'API_PORT=4001',
        'DEV_LOG_PORT=8788',
        'CORS_ORIGIN=http://localhost:3001',
        'NEXT_PUBLIC_API_BASE_URL=http://localhost:4001/api',
        'NEXT_PUBLIC_DEV_LOG_URL=http://localhost:8788/frontend-log',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(repoDir, 'services/chat/.env.local'),
      'DATABASE_URL=postgresql://localhost:5432/fx_test\n',
    );
    fs.writeFileSync(
      path.join(repoDir, 'clients/chat-web/.env.local'),
      'NEXT_PUBLIC_SENTRY_DSN=\n',
    );

    const run = spawnSync('bash', [SCRIPT_PATH, 'feat/wt-smoke', 'wt-smoke'], {
      cwd: repoDir,
      env: {
        ...process.env,
        WORKTREE_BASE_DIR: worktreesDir,
        SYMLINK_DIRS: 'changes',
        INSTALL_CMD: 'true',
      },
      encoding: 'utf8',
    });

    expect(run.status).toBe(0);

    const wtRootEnvPath = path.join(worktreeDir, '.env.local');
    expect(fs.existsSync(wtRootEnvPath)).toBe(true);
    const wtEnv = parseEnvFile(fs.readFileSync(wtRootEnvPath, 'utf8'));

    expect(wtEnv.WEB_PORT).toBeDefined();
    expect(wtEnv.API_PORT).toBeDefined();
    expect(wtEnv.DEV_LOG_PORT).toBeDefined();
    expect(wtEnv.WEB_PORT).not.toBe('3001');
    expect(wtEnv.API_PORT).not.toBe('4001');
    expect(wtEnv.DEV_LOG_PORT).not.toBe('8788');
    expect(wtEnv.CORS_ORIGIN).toBe(`http://localhost:${wtEnv.WEB_PORT}`);
    expect(wtEnv.NEXT_PUBLIC_API_BASE_URL).toBe(`http://localhost:${wtEnv.API_PORT}/api`);
    expect(wtEnv.NEXT_PUBLIC_DEV_LOG_URL).toBe(
      `http://localhost:${wtEnv.DEV_LOG_PORT}/frontend-log`,
    );

    const chatEnvPath = path.join(worktreeDir, 'services/chat/.env.local');
    const webEnvPath = path.join(worktreeDir, 'clients/chat-web/.env.local');
    expect(fs.existsSync(chatEnvPath)).toBe(true);
    expect(fs.existsSync(webEnvPath)).toBe(true);
    expect(fs.lstatSync(chatEnvPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(webEnvPath).isSymbolicLink()).toBe(false);
  });
});
