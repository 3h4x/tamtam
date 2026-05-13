import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const GIT_SHIM = resolve(__dirname, '..', '..', 'e2e', 'pipeline', 'mocks', 'bin', 'git');

function runGit(
  args: string[],
  cwd: string,
  shimDir: string,
) {
  return spawnSync(process.execPath, [GIT_SHIM, ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      TAMTAM_E2E_SHIM_DIR: shimDir,
    },
  });
}

describe('e2e pipeline git shim', () => {
  let dir: string;
  let shimDir: string;
  let projectDir: string;
  let projectShimDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tamtam-e2e-git-shim-'));
    shimDir = join(dir, 'shim-state');
    projectDir = join(dir, 'workspace', 'proj');
    projectShimDir = join(shimDir, 'proj');

    mkdirSync(join(projectDir, '.git'), { recursive: true });
    mkdirSync(projectShimDir, { recursive: true });
    writeFileSync(join(projectShimDir, 'git-state.json'), JSON.stringify({ committed: false, pushed: false }));
    writeFileSync(join(projectShimDir, 'git-branch'), 'master');
    writeFileSync(join(projectShimDir, 'git-merged-branches.json'), JSON.stringify([]));
    writeFileSync(join(projectShimDir, 'git-calls.jsonl'), '');
    writeFileSync(join(projectShimDir, 'timing.json'), JSON.stringify({}));
    writeFileSync(join(projectShimDir, 'git-failures.json'), JSON.stringify({}));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('tracks the created branch for checkout -b', () => {
    const checkout = runGit(['-C', projectDir, 'checkout', '-b', 'fix/issue-42-fix-login-bug'], projectDir, shimDir);
    expect(checkout.status).toBe(0);

    const current = runGit(['-C', projectDir, 'branch', '--show-current'], projectDir, shimDir);
    expect(current.status).toBe(0);
    expect(current.stdout.trim()).toBe('fix/issue-42-fix-login-bug');
    expect(readFileSync(join(projectShimDir, 'git-branch'), 'utf-8').trim()).toBe('fix/issue-42-fix-login-bug');
  });

  it('returns scripted merged branches for branch --merged', () => {
    writeFileSync(
      join(projectShimDir, 'git-merged-branches.json'),
      JSON.stringify(['fix/issue-9-already-merged', 'feature/older-branch']),
    );

    const merged = runGit(['-C', projectDir, 'branch', '--merged', 'master'], projectDir, shimDir);
    expect(merged.status).toBe(0);
    expect(merged.stdout).toContain('fix/issue-9-already-merged');
    expect(merged.stdout).toContain('feature/older-branch');
  });

  it('can fail checkout -b once and then allow the fallback checkout', () => {
    writeFileSync(
      join(projectShimDir, 'git-failures.json'),
      JSON.stringify({
        checkout: {
          exitCode: 128,
          stderr: 'branch already exists',
          matchArgs: ['-b', 'fix/issue-42-fix-login-bug'],
          once: true,
        },
      }),
    );

    const create = runGit(['-C', projectDir, 'checkout', '-b', 'fix/issue-42-fix-login-bug'], projectDir, shimDir);
    expect(create.status).toBe(128);
    expect(create.stderr).toContain('branch already exists');
    expect(readFileSync(join(projectShimDir, 'git-branch'), 'utf-8').trim()).toBe('master');

    const reuse = runGit(['-C', projectDir, 'checkout', 'fix/issue-42-fix-login-bug'], projectDir, shimDir);
    expect(reuse.status).toBe(0);
    expect(readFileSync(join(projectShimDir, 'git-branch'), 'utf-8').trim()).toBe('fix/issue-42-fix-login-bug');
  });
});
