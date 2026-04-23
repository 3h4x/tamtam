import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/project-data';
import { exec } from '@/lib/shell';
import { detectMainBranch } from '@/lib/start-commit';

// Switch the working copy back to the project's default branch.
// Used from the Changes tab when a feature branch has been pushed/merged and
// the user wants to get back to a clean base without dropping into a terminal.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  // Refuse if there are uncommitted changes — switching would either fail or
  // silently carry the changes across, which is never what the user wants here.
  const statusR = await exec(
    'git', ['-C', projPath, 'status', '--porcelain', '--ignore-submodules'],
    { timeout: 5000 },
  );
  if (statusR.stdout.trim()) {
    return NextResponse.json(
      { detail: 'Uncommitted changes present — commit or stash before switching branches' },
      { status: 409 },
    );
  }

  const defaultBranch = await detectMainBranch(projPath);

  const currentR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  if (currentR.stdout.trim() === defaultBranch) {
    return NextResponse.json({ status: 'already-on-branch', branch: defaultBranch });
  }

  const coR = await exec('git', ['-C', projPath, 'checkout', defaultBranch], { timeout: 10000 });
  if (coR.exitCode !== 0) {
    return NextResponse.json(
      { detail: `Failed to checkout ${defaultBranch}: ${coR.stderr.trim() || 'unknown git error'}` },
      { status: 500 },
    );
  }

  clearProjectDataCache();
  return NextResponse.json({ status: 'switched', branch: defaultBranch });
}
