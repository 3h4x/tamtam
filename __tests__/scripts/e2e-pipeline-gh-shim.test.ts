import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const GH_SHIM = resolve(__dirname, '..', '..', 'e2e', 'pipeline', 'mocks', 'bin', 'gh');

function runGh(
  args: string[],
  cwd: string,
  shimDir: string,
) {
  return spawnSync(process.execPath, [GH_SHIM, ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      TAMTAM_E2E_SHIM_DIR: shimDir,
    },
  });
}

describe('e2e pipeline gh shim', () => {
  let dir: string;
  let shimDir: string;
  let projectDir: string;
  let projectShimDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tamtam-e2e-gh-shim-'));
    shimDir = join(dir, 'shim-state');
    projectDir = join(dir, 'workspace', 'proj');
    projectShimDir = join(shimDir, 'proj');

    mkdirSync(projectDir, { recursive: true });
    mkdirSync(projectShimDir, { recursive: true });
    writeFileSync(join(projectShimDir, 'git-branch'), 'feature/reuse-pr');
    writeFileSync(join(projectShimDir, 'git-calls.jsonl'), '');
    writeFileSync(
      join(projectShimDir, 'gh-open-pr.json'),
      JSON.stringify({
        number: 7,
        url: 'https://github.com/test/repo/pull/7',
        headBranch: 'feature/reuse-pr',
        title: 'Existing PR',
        body: 'Reused PR body',
        state: 'OPEN',
        author: { login: 'trusted-user' },
      }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the scripted existing PR for branch-scoped pr view lookups', () => {
    const result = runGh(['pr', 'view', '--json', 'url'], projectDir, shimDir);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{"url":"https://github.com/test/repo/pull/7"}');
  });

  it('returns the scripted existing PR for pr list --head lookups', () => {
    const result = runGh(
      ['pr', 'list', '--head', 'feature/reuse-pr', '--state', 'open', '--json', 'url', '--limit', '1'],
      projectDir,
      shimDir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('[{"url":"https://github.com/test/repo/pull/7"}]');
  });

  it('returns no PR when the requested head does not match the scripted branch', () => {
    const result = runGh(
      ['pr', 'list', '--head', 'feature/other-branch', '--state', 'open', '--json', 'url', '--limit', '1'],
      projectDir,
      shimDir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('[]');
  });
});
