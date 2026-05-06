// Detects "large uncommitted change" state on a project working tree. Used as
// a gate to prevent agent runs from starting on top of in-progress edits the
// user hasn't committed yet — agent edits would otherwise tangle with WIP and
// either get committed by mistake or trigger noisy review/fix loops over code
// the user is mid-refactor.
//
// Counts every line of `git status --porcelain` (modified, staged, deleted,
// untracked) — the gate is about "scope of unsettled state", not just tracked
// changes. Fail-open on any git error: a flaky probe must never block runs.

import { exec } from '@/lib/shared/shell';

const cache = new Map<string, { count: number; ts: number }>();
const TTL_MS = 5_000;

/**
 * Returns the number of files with uncommitted changes (including untracked
 * files) at `projectPath`, or 0 on any git error.
 */
export async function getDirtyFileCount(projectPath: string): Promise<number> {
  const cached = cache.get(projectPath);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.count;

  let count = 0;
  try {
    const r = await exec('git', ['-C', projectPath, 'status', '--porcelain'], { timeout: 3000 });
    if (r.exitCode === 0) {
      const lines = r.stdout.split('\n').filter((l) => l.length > 0);
      count = lines.length;
    }
  } catch {
    // Fail-open: never block on probe error.
  }
  cache.set(projectPath, { count, ts: Date.now() });
  return count;
}

/** Drop cached state (call after operations that change the working tree). */
export function clearDirtyWorktreeCache(projectPath?: string): void {
  if (projectPath) cache.delete(projectPath);
  else cache.clear();
}
