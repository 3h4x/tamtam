import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  getCurrentBranch,
  setReviewedRef,
  getReviewedRefSha,
  isAncestor,
  clearReviewedRef,
} from '@/lib/git/git-utils';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

// Build a template repo once and clone it per test via fast filesystem copy.
// Cuts ~5 git invocations per test down to 1 (the post-copy nothing) and avoids
// re-running init/config/add/commit for every case.
const templateRepo = mkdtempSync(join(tmpdir(), 'tamtam-incremental-review-tmpl-'));
git(templateRepo, 'init', '-q', '-b', 'main');
writeFileSync(join(templateRepo, 'a.txt'), 'a');
execFileSync(
  'git',
  ['-c', 'user.email=t@t.test', '-c', 'user.name=tester', 'add', '.'],
  { cwd: templateRepo, encoding: 'utf-8' },
);
execFileSync(
  'git',
  ['-c', 'user.email=t@t.test', '-c', 'user.name=tester', 'commit', '-q', '-m', 'initial'],
  { cwd: templateRepo, encoding: 'utf-8' },
);
// Persist identity in repo config so subsequent commits in tests succeed.
git(templateRepo, 'config', 'user.email', 't@t.test');
git(templateRepo, 'config', 'user.name', 'tester');
// HEAD sha is identical across cloned repos; cache it to skip per-test rev-parse.
const templateHead = git(templateRepo, 'rev-parse', 'HEAD');

describe('incremental review git ref helpers', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'tamtam-incremental-review-'));
    cpSync(templateRepo, repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(templateRepo, { recursive: true, force: true });
  });

  it('reads the current branch', async () => {
    expect(await getCurrentBranch(repo)).toBe('main');
  });

  it('round-trips set/get on the reviewed ref', async () => {
    const head = templateHead;
    expect(await getReviewedRefSha(repo, 'main')).toBeNull();
    await setReviewedRef(repo, 'main');
    expect(await getReviewedRefSha(repo, 'main')).toBe(head);
  });

  it('isAncestor is true when ref is an ancestor of HEAD, false after rewind', async () => {
    const initial = templateHead;
    await setReviewedRef(repo, 'main');
    writeFileSync(join(repo, 'b.txt'), 'b');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'second');

    expect(await isAncestor(repo, initial, 'HEAD')).toBe(true);

    // Rewind to before the marker — the marker is no longer in HEAD's history
    git(repo, 'checkout', '-q', '-b', 'detour', initial);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'detour-1');
    const detourHead = git(repo, 'rev-parse', 'HEAD');
    // The marker (initial) IS an ancestor of detourHead since detour was made from initial
    expect(await isAncestor(repo, initial, detourHead)).toBe(true);

    // But a sha that isn't reachable from HEAD is not an ancestor
    git(repo, 'checkout', '-q', 'main');
    const mainSecond = git(repo, 'rev-parse', 'HEAD');
    expect(await isAncestor(repo, mainSecond, detourHead)).toBe(false);
  });

  it('clearReviewedRef removes the ref', async () => {
    await setReviewedRef(repo, 'main');
    expect(await getReviewedRefSha(repo, 'main')).not.toBeNull();
    await clearReviewedRef(repo, 'main');
    expect(await getReviewedRefSha(repo, 'main')).toBeNull();
  });

  it('handles branches with slashes in the name', async () => {
    git(repo, 'checkout', '-q', '-b', 'feature/x');
    expect(await getCurrentBranch(repo)).toBe('feature/x');
    await setReviewedRef(repo, 'feature/x');
    expect(await getReviewedRefSha(repo, 'feature/x')).toBe(templateHead);
  });
});
