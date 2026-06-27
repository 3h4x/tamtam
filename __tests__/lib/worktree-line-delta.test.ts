import { mkdtempSync, writeFileSync, rmSync, cpSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { exec } from '@/lib/shared/shell';
import { worktreeLineDelta } from '@/lib/git/worktree-line-delta';

async function git(cwd: string, ...args: string[]) {
  const r = await exec('git', args, { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

describe('worktreeLineDelta', () => {
  // Build the committed base repo once (5 git spawns total), then give each
  // test its own isolated copy via an in-process fs copy instead of re-running
  // init/config/add/commit per test (which dominated this file's runtime).
  let baseDir: string;
  let dir: string;
  beforeAll(async () => {
    baseDir = mkdtempSync(join(tmpdir(), 'wld-base-'));
    await git(baseDir, 'init', '-q');
    await git(baseDir, 'config', 'user.email', 't@t.t');
    await git(baseDir, 'config', 'user.name', 'T');
    writeFileSync(join(baseDir, 'a.txt'), 'one\ntwo\nthree\n');
    await git(baseDir, 'add', '.');
    await git(baseDir, 'commit', '-q', '-m', 'init');
  });
  afterAll(() => rmSync(baseDir, { recursive: true, force: true }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wld-'));
    cpSync(baseDir, dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns 0 on a clean tree', async () => {
    expect(await worktreeLineDelta(dir)).toBe(0);
  });

  it('sums added and removed lines across the dirty tree', async () => {
    // remove one line, add two; numstat row: 2 added, 1 removed
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nfour\nfive\n');
    expect(await worktreeLineDelta(dir)).toBe(3);
  });

  it('counts untracked files without staging them', async () => {
    writeFileSync(join(dir, 'b.txt'), 'x\ny\n');
    expect(await worktreeLineDelta(dir)).toBe(2);
  });

  it('preserves pre-existing staged changes while counting untracked files', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    await git(dir, 'add', 'a.txt');
    writeFileSync(join(dir, 'b.txt'), 'x\ny\n');

    const before = await git(dir, 'status', '--porcelain');
    expect(before).toContain('M  a.txt');
    expect(before).toContain('?? b.txt');

    expect(await worktreeLineDelta(dir)).toBe(3);
    expect(await git(dir, 'status', '--porcelain')).toBe(before);
  });

  it('ignores binary rows (numstat dash)', async () => {
    writeFileSync(join(dir, 'bin'), Buffer.from([0, 1, 2, 0, 3]));
    // binary contributes 0; tree otherwise clean
    expect(await worktreeLineDelta(dir)).toBe(0);
  });
});
