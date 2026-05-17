// Branch-freshness gate.
//
// Constraint: an agent run that starts on a branch which isn't rebased on
// top of the latest `origin/<default>` will produce conflicts as soon as
// it tries to merge / open a PR. We block the start instead of letting the
// agent burn budget on work that'll be wasted in a rebase later.
//
// What "fresh" means here:
//   - `git fetch origin <default>` succeeds (offline / no remote → soft-pass)
//   - `git rev-list --count HEAD..origin/<default>` == 0
//     (origin/<default> is an ancestor of HEAD, or the working branch IS
//      origin/<default> at its tip)
//
// Soft-pass on missing remote / fetch failure: tamtam is shared infra
// across many local repos; a transient network blip shouldn't block agent
// scheduling. The reconciler in `stranded-branch-reconcile` is what fixes
// the dirty/behind state — this gate is the safety belt that keeps new
// work off a stale branch in the meantime.
//
// Cache: fetch is the expensive op. Cache the per-project result for a
// short window so a tight burst of agent starts (cron + manual) doesn't
// hammer `git fetch` and the remote rate-limiter.

import { exec } from '@/lib/shared/shell';

export interface BranchFreshness {
  fresh: boolean;
  reason: string;
  behind: number;
  defaultBranch: string | null;
}

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map<string, { at: number; value: BranchFreshness }>();

export async function checkBranchFresh(projPath: string, options: { skipCache?: boolean } = {}): Promise<BranchFreshness> {
  if (!options.skipCache) {
    const hit = cache.get(projPath);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  }
  const value = await compute(projPath);
  cache.set(projPath, { at: Date.now(), value });
  return value;
}

async function compute(projPath: string): Promise<BranchFreshness> {
  // Resolve the configured default branch via origin/HEAD. Missing remote
  // → can't possibly be "behind" anything — soft-pass.
  const defR = await exec('git', ['-C', projPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { timeout: 5000 });
  if (defR.exitCode !== 0) {
    return { fresh: true, reason: 'no remote default branch', behind: 0, defaultBranch: null };
  }
  const def = defR.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  if (!def) {
    return { fresh: true, reason: 'no remote default branch', behind: 0, defaultBranch: null };
  }
  // Fetch the default branch only — cheap, no submodules. Soft-pass on
  // failure (offline, auth failure, transient network).
  const fetchR = await exec('git', ['-C', projPath, 'fetch', '--quiet', 'origin', def], { timeout: 30_000 });
  if (fetchR.exitCode !== 0) {
    return {
      fresh: true,
      reason: `fetch failed (${(fetchR.stderr || fetchR.stdout || 'unknown').trim().slice(0, 200)}) — soft-pass`,
      behind: 0,
      defaultBranch: def,
    };
  }
  // Behind origin/<default>? If yes, HEAD does NOT contain those commits
  // and the branch must be rebased before any agent work lands cleanly.
  const behindR = await exec('git', ['-C', projPath, 'rev-list', '--count', `HEAD..origin/${def}`], { timeout: 5000 });
  if (behindR.exitCode !== 0) {
    return {
      fresh: true,
      reason: `behind-count exit ${behindR.exitCode} — soft-pass`,
      behind: 0,
      defaultBranch: def,
    };
  }
  const behind = parseInt(behindR.stdout.trim(), 10) || 0;
  if (behind > 0) {
    return {
      fresh: false,
      reason: `branch is ${behind} commit${behind === 1 ? '' : 's'} behind origin/${def} — rebase before starting agent`,
      behind,
      defaultBranch: def,
    };
  }
  return { fresh: true, reason: 'up to date', behind: 0, defaultBranch: def };
}

/** Test-only: clear cache so cases stay isolated. */
export function _resetBranchFreshnessCacheForTest(): void {
  cache.clear();
}
