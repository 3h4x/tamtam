// Helpers for detecting "issue branch active" state on a project — a working
// tree currently checked out on a `fix/issue-N-…` branch. While that's true,
// scheduled agent runs are skipped to prevent them from accidentally landing
// edits on (or pushing commits to) someone's in-progress feature branch.
//
// Background: agents run with `cwd = projPath`, so whatever branch is checked
// out is the branch they edit. If a user checks out `fix/issue-9-…` to keep
// working on it manually, the next scheduled `tests` / `docs-claude` / etc.
// agent fire will execute against that branch — committing unrelated changes
// onto someone's feature branch and creating cross-issue noise. Same race
// happens after an issue-driven Work-on session has paused for review.

import { exec } from '@/lib/shared/shell';
import { resolveProjectPath } from './project-data';

const ISSUE_BRANCH_RE = /^fix\/issue-\d+/;

// Tiny TTL cache so a 100ms scheduler tick burst doesn't shell out N times.
// Cleared by callers that change the working tree (issue-branch / checkout-default).
const cache = new Map<string, { lockedBy: string | null; ts: number }>();
const TTL_MS = 5_000;

/**
 * Returns the issue branch holding the project hostage, or null if the
 * working tree is clean (on the default branch or any non-issue branch).
 *
 * Best-effort: any shell error returns `null` (don't block runs on flaky git).
 */
export async function getIssueBranchLock(projectName: string): Promise<string | null> {
  const cached = cache.get(projectName);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.lockedBy;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    cache.set(projectName, { lockedBy: null, ts: Date.now() });
    return null;
  }

  let lockedBy: string | null = null;
  try {
    const r = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 3000 });
    if (r.exitCode === 0) {
      const branch = r.stdout.trim();
      if (branch && ISSUE_BRANCH_RE.test(branch)) lockedBy = branch;
    }
  } catch {
    // git missing / not a repo / timeout — treat as unlocked.
  }
  cache.set(projectName, { lockedBy, ts: Date.now() });
  return lockedBy;
}

/** Drop the cached lock state for a project (call after switching branches). */
export function clearIssueBranchLockCache(projectName?: string): void {
  if (projectName) cache.delete(projectName);
  else cache.clear();
}
