import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/auth';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/project-data';
import { invalidateProject } from '@/lib/gh-status';
import { exec } from '@/lib/shell';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;
  const { projectName } = await params;
  const body = await request.json();
  const message = body.message;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  await exec('git', ['-C', projPath, 'add', '-A'], { timeout: 10000 });

  const statusR = await exec('git', ['-C', projPath, 'diff', '--cached', '--name-status'], { timeout: 10000 });
  if (!statusR.stdout.trim()) {
    return NextResponse.json({ status: 'success', message: 'No changes to push', commit_sha: '' });
  }

  const commitR = await exec('git', ['-C', projPath, 'commit', '-m', message], { timeout: 30000 });
  if (commitR.exitCode !== 0 && !commitR.stdout.includes('nothing to commit')) {
    return NextResponse.json({ detail: `Commit failed: ${commitR.stderr.trim()}` }, { status: 400 });
  }

  let pushR = await exec('git', ['-C', projPath, 'push'], { timeout: 30000 });
  if (pushR.exitCode !== 0) {
    if (pushR.stderr.includes('no upstream') || pushR.stderr.includes('set-upstream')) {
      const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
      const branch = branchR.stdout.trim();
      if (branch) {
        pushR = await exec('git', ['-C', projPath, 'push', '-u', 'origin', branch], { timeout: 30000 });
      }
    }
    if (pushR.exitCode !== 0) {
      return NextResponse.json({ detail: `Push failed: ${pushR.stderr.trim()}` }, { status: 400 });
    }
  }

  const shaR = await exec('git', ['-C', projPath, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
  const commitSha = shaR.exitCode === 0 ? shaR.stdout.trim() : '';

  invalidateProject(projectName);
  clearProjectDataCache();

  return NextResponse.json({ status: 'success', message: 'Changes pushed successfully', commit_sha: commitSha });
}
