import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/shared/project-data';
import { clearIssueBranchLockCache } from '@/lib/shared/project-branch-lock';
import { exec } from '@/lib/shared/shell';
import { detectMainBranch } from '@/lib/pipeline/start-commit';

// Switch the working copy back to the project's default branch.
// Used from the Changes tab when a feature branch has been pushed/merged and
// the user wants to get back to a clean base without dropping into a terminal.
//
// Body (optional): { carryChanges?: boolean }
//   - carryChanges=true: stash uncommitted changes, switch, then pop the stash
//     on default so the user's work moves with them. Used by the "merged branch"
//     rescue button on the Changes tab.
//   - default behavior: refuse when there are uncommitted changes.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  let carryChanges = false;
  try {
    const body = await req.json();
    carryChanges = !!body?.carryChanges;
  } catch {
    // no body is fine — fall back to default (strict) behavior
  }

  const statusR = await exec(
    'git', ['-C', projPath, 'status', '--porcelain', '--ignore-submodules'],
    { timeout: 5000 },
  );
  const dirty = statusR.stdout.trim().length > 0;
  if (dirty && !carryChanges) {
    return NextResponse.json(
      { detail: 'Uncommitted changes present — commit or stash before switching branches' },
      { status: 409 },
    );
  }

  const defaultBranch = await detectMainBranch(projPath);

  const currentR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  const currentBranch = currentR.stdout.trim();
  if (currentBranch === defaultBranch) {
    return NextResponse.json({ status: 'already-on-branch', branch: defaultBranch });
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
      return NextResponse.json(
        { detail: `Failed to stash changes: ${stashR.stderr.trim() || 'unknown git error'}` },
        { status: 500 },
      );
    }
  }

  const coR = await exec('git', ['-C', projPath, 'checkout', defaultBranch], { timeout: 10000 });
  if (coR.exitCode !== 0) {
    if (stashed) await exec('git', ['-C', projPath, 'stash', 'pop'], { timeout: 10000 });
    return NextResponse.json(
      { detail: `Failed to checkout ${defaultBranch}: ${coR.stderr.trim() || 'unknown git error'}` },
      { status: 500 },
    );
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
      return NextResponse.json(
        {
          status: 'switched-stash-kept',
          branch: defaultBranch,
          deletedBranch,
          detail: `Switched to ${defaultBranch} but could not apply stashed changes: ${popR.stderr.trim() || 'merge conflict'}. Run 'git stash list' to recover.`,
        },
        { status: 207 },
      );
    }
  }

  clearProjectDataCache();
  clearIssueBranchLockCache(projectName);
  return NextResponse.json({ status: 'switched', branch: defaultBranch, deletedBranch });
}
