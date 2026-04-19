import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/project-data';
import { exec } from '@/lib/shell';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const addR = await exec('git', ['-C', projPath, 'add', '-A'], { timeout: 10000 });
  if (addR.exitCode !== 0) {
    return NextResponse.json({ detail: `Git add failed: ${addR.stderr}` }, { status: 400 });
  }

  const statusR = await exec('git', ['-C', projPath, 'status', '--porcelain', '--ignore-submodules'], { timeout: 10000 });
  if (!statusR.stdout.trim()) {
    return NextResponse.json({ status: 'success', message: 'No changes to push', output: '' });
  }

  const commitR = await exec('git', ['-C', projPath, 'commit', '-m', `chore: update ${projectName}`], { timeout: 10000 });
  if (commitR.exitCode !== 0 && !commitR.stdout.includes('nothing to commit')) {
    return NextResponse.json({ detail: `Commit failed: ${commitR.stderr}` }, { status: 400 });
  }

  const pushR = await exec('git', ['-C', projPath, 'push'], { timeout: 30000 });
  if (pushR.exitCode !== 0) {
    return NextResponse.json({ detail: `Push failed: ${pushR.stderr}` }, { status: 400 });
  }

  return NextResponse.json({ status: 'success', message: 'Changes pushed successfully', output: pushR.stdout });
}
