import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/shared/project-data';
import { clearIssueBranchLockCache } from '@/lib/shared/project-branch-lock';
import { exec } from '@/lib/shared/shell';
import { getProjectTestConfig } from '@/lib/scheduling/scheduling';
import { getLock } from '@/lib/pipeline/pipeline-lock';
import { listJobs } from '@/lib/jobs/job-storage';

// Given an issue context (number + title), check out a feature branch
// `fix/issue-<n>-<slug>` before Claude starts editing so all interim work
// lands on the branch instead of the default branch.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  // Refuse to switch branches while a pipeline is actively running. A mid-pipeline
  // checkout would leave the working copy in an inconsistent state (e.g. a test
  // job finishing on a different branch than it started on).
  const activeLock = getLock(projectName);
  if (activeLock) {
    const holder = listJobs().find(j => j.id === activeLock.lockedByJobId);
    if (holder && holder.finishedAt === null) {
      return NextResponse.json(
        { detail: `Pipeline is running for ${projectName} — wait for it to finish before switching branches`, blockingJobId: activeLock.lockedByJobId },
        { status: 409 }
      );
    }
  }

  // Project-level kill switch: when the user unchecks "Create feature branch"
  // in the Work-on config, this endpoint is a no-op — Claude works on whatever
  // branch is currently checked out.
  const cfg = getProjectTestConfig(projectName);
  if (cfg && cfg.issueAutoBranch === false) {
    return NextResponse.json({ status: 'skipped', reason: 'issue_auto_branch is disabled for this project' });
  }

  let body: { issue_number?: number; issue_title?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ detail: 'invalid JSON' }, { status: 400 }); }

  const issueNumber = Number(body.issue_number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return NextResponse.json({ detail: 'issue_number required' }, { status: 400 });
  }
  const title = (body.issue_title ?? '').toString();

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const branch = `fix/issue-${issueNumber}${slug ? `-${slug}` : ''}`;

  const currentR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  const currentBranch = currentR.stdout.trim();
  if (currentBranch === branch) {
    return NextResponse.json({ status: 'already-on-branch', branch });
  }

  // Detect a zombie branch: the issue was already closed/merged, but the local
  // ref is still around. Checking it out would resurrect dead work and pile
  // new commits on top of an already-merged branch. Resolve the default branch
  // (prefer the remote HEAD symref) and skip if the issue branch is fully
  // merged into it.
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
    return NextResponse.json({
      status: 'skipped',
      reason: `branch ${branch} already merged into ${defaultBranch}`,
      branch,
      currentBranch,
    });
  }

  // Create-or-checkout. We deliberately preserve uncommitted work by not
  // touching the index — `git checkout -b` carries the working tree across.
  const createR = await exec('git', ['-C', projPath, 'checkout', '-b', branch], { timeout: 10000 });
  if (createR.exitCode === 0) {
    clearProjectDataCache();
    clearIssueBranchLockCache(projectName);
    return NextResponse.json({ status: 'created', branch });
  }
  const existingR = await exec('git', ['-C', projPath, 'checkout', branch], { timeout: 10000 });
  if (existingR.exitCode === 0) {
    clearProjectDataCache();
    clearIssueBranchLockCache(projectName);
    return NextResponse.json({ status: 'reused', branch });
  }
  return NextResponse.json(
    { detail: `Failed to checkout ${branch}: ${createR.stderr || existingR.stderr}` },
    { status: 500 },
  );
}
