import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/project-data';
import { exec } from '@/lib/shell';
import { detectMainBranch } from '@/lib/start-commit';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const [currentR, defaultBranch] = await Promise.all([
    exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 }),
    detectMainBranch(projPath),
  ]);

  const branch = currentR.stdout.trim() || null;

  // commitsAhead: how many commits the current branch has that aren't
  // reachable from origin/<defaultBranch>. 0 means there's nothing for
  // `gh pr create` to PR, which would fail with "No commits between
  // base and head". The UI uses this to disable Create PR with a clear
  // tooltip instead of relying on the user to interpret a 500.
  // No `git fetch` here — this endpoint is polled every 10s and a network
  // round-trip per poll is too expensive. Stale local origin/<default>
  // can produce a false enabled state, which then surfaces the same
  // gh error as before — no regression vs. today.
  let commitsAhead: number | null = null;
  if (branch && branch !== defaultBranch) {
    const aheadR = await exec(
      'git',
      ['-C', projPath, 'rev-list', '--count', `origin/${defaultBranch}..HEAD`],
      { timeout: 5000 },
    );
    if (aheadR.exitCode === 0) {
      const n = parseInt(aheadR.stdout.trim(), 10);
      if (Number.isFinite(n)) commitsAhead = n;
    }
  }

  return NextResponse.json({ branch, defaultBranch, commitsAhead });
}
