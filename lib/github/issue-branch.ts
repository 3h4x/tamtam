import { exec } from '@/lib/shared/shell';
import { getProjectTestConfig } from '@/lib/scheduling/scheduling';
import { getLock } from '@/lib/pipeline/pipeline-lock';
import { listJobs } from '@/lib/jobs/job-storage';
import { clearProjectDataCache } from '@/lib/shared/project-data';
import { clearIssueBranchLockCache } from '@/lib/shared/project-branch-lock';

export type EnsureIssueBranchResult =
  | { status: 'created' | 'reused' | 'already-on-branch'; branch: string }
  | { status: 'skipped'; reason: string; branch?: string }
  | { status: 'pipeline-running'; blockingJobId: string }
  | { status: 'error'; detail: string };

export function issueBranchName(issueNumber: number, issueTitle: string): string {
  const slug = issueTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `fix/issue-${issueNumber}${slug ? `-${slug}` : ''}`;
}

/**
 * Create-or-checkout `fix/issue-<n>-<slug>` for the given project, honouring
 * pipeline locks, project-level `issueAutoBranch` opt-out, and zombie-branch
 * detection. Working tree changes are carried across (no stash).
 *
 * Used by both the legacy POST `/api/projects/.../issue-branch` route and the
 * `pick_top=1` flow on the issues route — the latter so issue-cruncher agents
 * never need to run `git checkout` themselves (it's denied at the Claude
 * permission layer for that skill).
 */
export async function ensureIssueBranch(opts: {
  projectName: string;
  projPath: string;
  issueNumber: number;
  issueTitle: string;
}): Promise<EnsureIssueBranchResult> {
  const { projectName, projPath, issueNumber, issueTitle } = opts;

  const activeLock = await getLock(projectName);
  if (activeLock) {
    const holder = listJobs().find((j) => j.id === activeLock.lockedByJobId);
    if (holder && holder.finishedAt === null) {
      return { status: 'pipeline-running', blockingJobId: activeLock.lockedByJobId };
    }
  }

  const cfg = await getProjectTestConfig(projectName);
  if (cfg && cfg.issueAutoBranch === false) {
    return { status: 'skipped', reason: 'issue_auto_branch is disabled for this project' };
  }

  const branch = issueBranchName(issueNumber, issueTitle);

  const currentR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  if (currentR.stdout.trim() === branch) {
    return { status: 'already-on-branch', branch };
  }

  // Zombie-branch guard: if the issue branch already exists locally and is
  // fully merged into the default branch, re-checking it out would resurrect
  // dead work. Skip with a clear reason so the caller can surface it.
  const defaultR = await exec(
    'git',
    ['-C', projPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    { timeout: 5000 },
  );
  const defaultBranch = (defaultR.stdout.trim().split('/').pop() || 'master').trim();
  const mergedR = await exec(
    'git',
    ['-C', projPath, 'branch', '--merged', defaultBranch],
    { timeout: 5000 },
  );
  const mergedBranches = mergedR.stdout
    .split('\n')
    .map((l) => l.replace(/^\*?\s+/, '').trim())
    .filter(Boolean);
  if (mergedBranches.includes(branch)) {
    return {
      status: 'skipped',
      reason: `branch ${branch} already merged into ${defaultBranch}`,
      branch,
    };
  }

  const createR = await exec('git', ['-C', projPath, 'checkout', '-b', branch], { timeout: 10000 });
  if (createR.exitCode === 0) {
    clearProjectDataCache();
    clearIssueBranchLockCache(projectName);
    return { status: 'created', branch };
  }
  const existingR = await exec('git', ['-C', projPath, 'checkout', branch], { timeout: 10000 });
  if (existingR.exitCode === 0) {
    clearProjectDataCache();
    clearIssueBranchLockCache(projectName);
    return { status: 'reused', branch };
  }
  return {
    status: 'error',
    detail: `Failed to checkout ${branch}: ${createR.stderr || existingR.stderr}`,
  };
}
