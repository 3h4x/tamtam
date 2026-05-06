import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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

describe('incremental review git ref helpers', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'tamtam-incremental-review-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.test');
    git(repo, 'config', 'user.name', 'tester');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'initial');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reads the current branch', async () => {
    expect(await getCurrentBranch(repo)).toBe('main');
  });

  it('round-trips set/get on the reviewed ref', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(await getReviewedRefSha(repo, 'main')).toBeNull();
    await setReviewedRef(repo, 'main');
    expect(await getReviewedRefSha(repo, 'main')).toBe(head);
  });

  it('isAncestor is true when ref is an ancestor of HEAD, false after rewind', async () => {
    const initial = git(repo, 'rev-parse', 'HEAD');
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
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(await getReviewedRefSha(repo, 'feature/x')).toBe(head);
  });
});
