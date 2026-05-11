import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const GIT_MOCK = resolve(__dirname, '..', '..', 'scripts', 'qa-mocks', 'git');

function runGit(args: string[], cwd: string) {
  return spawnSync(GIT_MOCK, args, {
    cwd,
    encoding: 'utf-8',
    env: process.env,
  });
}

describe('scripts/qa-mocks/git', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qa-git-mock-'));
    writeFileSync(join(dir, '.qa-state.json'), JSON.stringify({
      name: 'web-console',
      branch: 'feature/qa-dashboard',
      github: 'qa/web-console',
      changes: ' M components/Dashboard.tsx\n M package.json\n?? e2e/dashboard.spec.ts\n',
    }, null, 2));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns name-status and numstat records for tracked QA changes', () => {
    const nameStatus = runGit(['diff', 'HEAD', '--name-status'], dir);
    const numstat = runGit(['diff', 'HEAD', '--numstat'], dir);

    expect(nameStatus.status).toBe(0);
    expect(nameStatus.stdout).toContain('M\tcomponents/Dashboard.tsx');
    expect(nameStatus.stdout).toContain('M\tpackage.json');
    expect(nameStatus.stdout).not.toContain('e2e/dashboard.spec.ts');

    expect(numstat.status).toBe(0);
    expect(numstat.stdout).toContain('\tcomponents/Dashboard.tsx');
    expect(numstat.stdout).toContain('\tpackage.json');
    expect(numstat.stdout).not.toContain('diff --git');
  });

  it('returns untracked files and porcelain-v2 branch metadata', () => {
    const untracked = runGit(['ls-files', '--others', '--exclude-standard'], dir);
    const porcelain = runGit(['status', '--porcelain=v2', '--branch'], dir);

    expect(untracked.status).toBe(0);
    expect(untracked.stdout.trim()).toBe('e2e/dashboard.spec.ts');

    expect(porcelain.status).toBe(0);
    expect(porcelain.stdout).toContain('# branch.head feature/qa-dashboard');
    expect(porcelain.stdout).toContain('# branch.ab +3 -0');
    expect(porcelain.stdout).toContain('? e2e/dashboard.spec.ts');
  });
});
