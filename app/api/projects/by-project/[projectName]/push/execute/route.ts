import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/project-data';
import { invalidateProject } from '@/lib/gh-status';
import { exec } from '@/lib/shell';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json();
  const message = body.message;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  await exec('git', ['-C', projPath, 'add', '-A'], { timeout: 10000 });

  const statusR = await exec('git', ['-C', projPath, 'diff', '--cached', '--name-status'], { timeout: 10000 });
  const hasStaged = !!statusR.stdout.trim();

  if (hasStaged) {
    const commitR = await exec('git', ['-C', projPath, 'commit', '--no-verify', '-m', message], { timeout: 30000 });
    if (commitR.exitCode !== 0 && !commitR.stdout.includes('nothing to commit')) {
      return NextResponse.json({ detail: `Commit failed: ${commitR.stderr.trim()}` }, { status: 400 });
    }
  } else {
    // Nothing staged — but maybe there are unpushed local commits. Check ahead-count.
    const aheadR = await exec('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
    const ahead = parseInt(aheadR.stdout.trim(), 10);
    if (!aheadR.stdout.trim() || aheadR.exitCode !== 0 || isNaN(ahead) || ahead === 0) {
      return NextResponse.json({ status: 'success', message: 'No changes to push', commit_sha: '' });
    }
  }

  // Auto-rebase if behind remote to prevent non-fast-forward rejection
  const branchStatusR = await exec('git', ['-C', projPath, 'status', '--porcelain=v2', '--branch'], { timeout: 5000 });
  const abLine = branchStatusR.stdout.split('\n').find(l => l.startsWith('# branch.ab '));
  const behind = abLine ? parseInt(abLine.match(/-(\d+)/)?.[1] ?? '0', 10) : 0;
  if (behind > 0) {
    const rebaseR = await exec('git', ['-C', projPath, 'pull', '--rebase'], { timeout: 60000 });
    if (rebaseR.exitCode !== 0) {
      const detail = (rebaseR.stderr || rebaseR.stdout)
        .split('\n').filter(l => !l.startsWith('hint:')).join('\n').trim().slice(0, 1000);
      return NextResponse.json({ detail: `Rebase failed: ${detail || 'conflict during rebase'}` }, { status: 409 });
    }
  }

  let pushR = await exec('git', ['-C', projPath, 'push'], { timeout: 30000 });
  if (pushR.exitCode !== 0 && (pushR.stderr.includes('no upstream') || pushR.stderr.includes('set-upstream'))) {
    const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
    const branch = branchR.stdout.trim();
    if (branch) pushR = await exec('git', ['-C', projPath, 'push', '-u', 'origin', branch], { timeout: 30000 });
  }
  if (pushR.exitCode !== 0) {
    return NextResponse.json({ detail: `Push failed: ${pushR.stderr.trim()}` }, { status: 400 });
  }

  const shaR = await exec('git', ['-C', projPath, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
  const commitSha = shaR.exitCode === 0 ? shaR.stdout.trim() : '';

  invalidateProject(projectName);
  clearProjectDataCache();

  return NextResponse.json({ status: 'success', message: 'Changes pushed successfully', commit_sha: commitSha });
}
