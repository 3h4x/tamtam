// Switch the working copy back to the project's default branch.
//
// Extracted from `app/api/projects/by-project/[projectName]/checkout-default/route.ts`.
// Shared by the route handler (UI "merged branch" rescue button) and the
// agent-action orchestrator (where the agent finishes its issue work and
// asks tamtam to return the worktree to default).
//
// Behavior contract is preserved exactly so existing route tests pass:
//   - carryChanges=false (default): refuse if there are uncommitted changes
//   - carryChanges=true: stash, switch, delete merged source branch, pop stash
//   - "already on default" returns ok with status='already-on-branch'
//   - if popping the stash fails, the result returns status='switched-stash-kept'
//     so the caller can surface the recovery hint to the user

import { exec } from '@/lib/shared/shell';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/shared/project-data';
import { detectMainBranch } from '@/lib/pipeline/start-commit';

export interface CheckoutDefaultInput {
  project: string;
  carryChanges?: boolean;
}

export type CheckoutDefaultResult =
  | { ok: true; status: 'switched' | 'already-on-branch'; branch: string; deletedBranch: string | null }
  | { ok: true; status: 'switched-stash-kept'; branch: string; deletedBranch: string | null; detail: string }
  | { ok: false; status: number; detail: string };

export async function checkoutDefault(input: CheckoutDefaultInput): Promise<CheckoutDefaultResult> {
  const { project, carryChanges = false } = input;
  const projPath = resolveProjectPath(project);
  if (!projPath) return { ok: false, status: 404, detail: 'project not found' };

  const statusR = await exec(
    'git', ['-C', projPath, 'status', '--porcelain', '--ignore-submodules'],
    { timeout: 5000 },
  );
  const dirty = statusR.stdout.trim().length > 0;
  if (dirty && !carryChanges) {
    return {
      ok: false,
      status: 409,
      detail: 'Uncommitted changes present — commit or stash before switching branches',
    };
  }

  const currentR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  const currentBranch = currentR.stdout.trim();

  const defaultBranch = await detectMainBranch(projPath);
  if (currentBranch === defaultBranch) {
    return { ok: true, status: 'already-on-branch', branch: defaultBranch, deletedBranch: null };
  }

  // Capture "is the branch we're leaving already merged into default?" BEFORE
  // the checkout. Detected via `git rev-list --count origin/<default>..HEAD`
  // which needs origin to be current — a lightweight fetch covers that.
  await exec('git', ['-C', projPath, 'fetch', '--quiet', 'origin', defaultBranch], { timeout: 10000 });
  const aheadR = await exec(
    'git',
    ['-C', projPath, 'rev-list', '--count', `origin/${defaultBranch}..HEAD`],
    { timeout: 5000 },
  );
  const branchWasMerged =
    aheadR.exitCode === 0 && parseInt(aheadR.stdout.trim(), 10) === 0;

  let stashed = false;
  if (dirty && carryChanges) {
    const stashR = await exec(
      'git', ['-C', projPath, 'stash', 'push', '-u', '-m', `tamtam: checkout-default ${Date.now()}`],
      { timeout: 15000 },
    );
    stashed = stashR.exitCode === 0 && !/No local changes/i.test(stashR.stdout);
    if (stashR.exitCode !== 0) {
      return {
        ok: false,
        status: 500,
        detail: `Failed to stash changes: ${stashR.stderr.trim() || 'unknown git error'}`,
      };
    }
  }

  const coR = await exec('git', ['-C', projPath, 'checkout', defaultBranch], { timeout: 10000 });
  if (coR.exitCode !== 0) {
    if (stashed) await exec('git', ['-C', projPath, 'stash', 'pop'], { timeout: 10000 });
    return {
      ok: false,
      status: 500,
      detail: `Failed to checkout ${defaultBranch}: ${coR.stderr.trim() || 'unknown git error'}`,
    };
  }

  let deletedBranch: string | null = null;
  if (branchWasMerged && currentBranch && currentBranch !== defaultBranch) {
    const delR = await exec(
      'git', ['-C', projPath, 'branch', '-D', currentBranch],
      { timeout: 5000 },
    );
    if (delR.exitCode === 0) deletedBranch = currentBranch;
  }

  if (stashed) {
    const popR = await exec('git', ['-C', projPath, 'stash', 'pop'], { timeout: 15000 });
    if (popR.exitCode !== 0) {
      // Leave the stash intact so the user can recover; surface the problem.
      return {
        ok: true,
        status: 'switched-stash-kept',
        branch: defaultBranch,
        deletedBranch,
        detail: `Switched to ${defaultBranch} but could not apply stashed changes: ${popR.stderr.trim() || 'merge conflict'}. Run 'git stash list' to recover.`,
      };
    }
  }

  clearProjectDataCache();
  return { ok: true, status: 'switched', branch: defaultBranch, deletedBranch };
}
