import { exec } from '@/lib/shared/shell';
import { getProjectTestConfig } from '@/lib/scheduling/scheduling';
import { getLock } from '@/lib/pipeline/pipeline-lock';
import { listJobs } from '@/lib/jobs/job-storage';
import { clearProjectDataCache } from '@/lib/shared/project-data';

export type EnsureIssueBranchResult =
  | { status: 'created' | 'reused' | 'already-on-branch'; branch: string }
  // `cause` lets callers distinguish a *legitimate* skip (the project opted out
  // of auto-branching, or the branch is already merged so the issue is done)
  // from `dirty-tree`, where the work simply could not be isolated and the
  // caller must NOT proceed to run/ship issue work on the current branch.
  | { status: 'skipped'; reason: string; branch?: string; cause: 'opt-out' | 'dirty-tree' | 'merged' }
  | { status: 'pipeline-running'; blockingJobId: string }
  | { status: 'error'; detail: string };

/**
 * Check out an EXISTING PR head branch (used when an open PR already implements
 * the picked issue). Honours the same pipeline-lock + dirty-tree guards as
 * `ensureIssueBranch`, then fetches and checks out the remote branch so the
 * agent verifies against the PR's actual implementation. Does not create a new
 * branch — the branch must already exist on origin.
 */
export async function checkoutPrBranch(opts: {
  projectName: string;
  projPath: string;
  branch: string;
}): Promise<EnsureIssueBranchResult> {
  const { projectName, projPath, branch } = opts;

  const activeLock = await getLock(projectName);
  if (activeLock) {
    const holder = listJobs().find((j) => j.id === activeLock.lockedByJobId);
    if (holder && holder.finishedAt === null) {
      return { status: 'pipeline-running', blockingJobId: activeLock.lockedByJobId };
    }
  }

  const currentR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  if (currentR.stdout.trim() === branch) {
    return { status: 'already-on-branch', branch };
  }

  const dirtyR = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
  if (dirtyR.exitCode === 0 && dirtyR.stdout.trim().length > 0) {
    return {
      status: 'skipped',
      reason: `working tree has uncommitted changes — refusing to switch to PR branch ${branch}`,
      branch,
      cause: 'dirty-tree',
    };
  }

  await exec('git', ['-C', projPath, 'fetch', '--quiet', 'origin', branch], { timeout: 30000 }).catch(() => {});
  // Point a local branch at the freshly-fetched remote head (create or reset).
  const coR = await exec(
    'git',
    ['-C', projPath, 'checkout', '-B', branch, `origin/${branch}`],
    { timeout: 15000 },
  );
  if (coR.exitCode !== 0) {
    // Fall back to a plain checkout (e.g. the local branch already tracks it).
    const plain = await exec('git', ['-C', projPath, 'checkout', branch], { timeout: 10000 });
    if (plain.exitCode !== 0) {
      return { status: 'error', detail: `Failed to checkout PR branch ${branch}: ${coR.stderr || plain.stderr}` };
    }
  }
  clearProjectDataCache();
  return { status: 'reused', branch };
}

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
    return { status: 'skipped', reason: 'issue_auto_branch is disabled for this project', cause: 'opt-out' };
  }

  const branch = issueBranchName(issueNumber, issueTitle);

  // Independent reads — parallelize. The early-return on "already on branch"
  // is the rare case, so doing both in parallel saves ~10-30 ms in the common
  // create/reuse path.
  const [currentR, defaultR] = await Promise.all([
    exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 }),
    exec('git', ['-C', projPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { timeout: 5000 }),
  ]);
  if (currentR.stdout.trim() === branch) {
    return { status: 'already-on-branch', branch };
  }

  // Dirty-tree guard: we are about to switch to a DIFFERENT branch (the
  // already-on-branch fast path above handles the same-branch case, where dirt
  // is this issue's own in-progress work). `git checkout` / `checkout -b`
  // *carries uncommitted changes across* — so a tree left dirty by a prior
  // stalled run (whose release never committed/shipped) would drag that stranded
  // work onto this issue's fresh branch, entangling unrelated issues on one
  // branch (the recurring "splątanie"). Refuse and leave the dirt on the current
  // branch for the stranded-branch reconciler to recover; the caller proceeds on
  // the current branch rather than spreading the mess.
  const dirtyR = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
  if (dirtyR.exitCode === 0 && dirtyR.stdout.trim().length > 0) {
    return {
      status: 'skipped',
      reason: `working tree has uncommitted changes — refusing to switch to ${branch} and carry stranded work across`,
      branch,
      cause: 'dirty-tree',
    };
  }

  // Zombie-branch guard: if the issue branch already exists locally and is
  // fully merged into the default branch, re-checking it out would resurrect
  // dead work. Skip with a clear reason so the caller can surface it.
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
      cause: 'merged',
    };
  }

  // Base the new branch on the LATEST origin/<default>, not the local (possibly
  // stale) default — cutting from a stale local default is the root cause of
  // "PRs suddenly conflict even though only we touch the repo": the branch is
  // born behind origin and overlapping changes on the advancing default pile up
  // into a merge conflict by PR time. Fetch first and branch off origin/<default>;
  // fall back to local HEAD when origin is unavailable (offline) or the working
  // tree can't be carried cleanly onto fresh origin (the push/pr-behind path
  // rebases later in that case).
  await exec('git', ['-C', projPath, 'fetch', '--quiet', 'origin', defaultBranch], { timeout: 30000 }).catch(() => {});
  const originDefaultRef = `origin/${defaultBranch}`;
  const haveOriginDefault =
    (await exec('git', ['-C', projPath, 'rev-parse', '--verify', '--quiet', originDefaultRef], { timeout: 5000 })).exitCode === 0;
  let createR = haveOriginDefault
    ? await exec('git', ['-C', projPath, 'checkout', '-b', branch, originDefaultRef], { timeout: 15000 })
    : await exec('git', ['-C', projPath, 'checkout', '-b', branch], { timeout: 10000 });
  if (createR.exitCode !== 0 && haveOriginDefault) {
    // Couldn't base on fresh origin (e.g. local tree changes can't carry) — fall
    // back to a plain create from local HEAD.
    createR = await exec('git', ['-C', projPath, 'checkout', '-b', branch], { timeout: 10000 });
  }
  if (createR.exitCode === 0) {
    clearProjectDataCache();
    return { status: 'created', branch };
  }
  const existingR = await exec('git', ['-C', projPath, 'checkout', branch], { timeout: 10000 });
  if (existingR.exitCode === 0) {
    clearProjectDataCache();
    return { status: 'reused', branch };
  }
  return {
    status: 'error',
    detail: `Failed to checkout ${branch}: ${createR.stderr || existingR.stderr}`,
  };
}
