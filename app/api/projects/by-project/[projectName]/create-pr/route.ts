import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/project-data';
import { exec } from '@/lib/shell';
import { detectMainBranch } from '@/lib/start-commit';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: 'Project not found' }, { status: 404 });
  }

  // Refuse to create a PR from the default branch — gh would reject it, but
  // fail fast with a clean error rather than pushing first.
  const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  const currentBranch = branchR.stdout.trim();
  if (!currentBranch) {
    return NextResponse.json({ detail: 'Not on a branch (detached HEAD)' }, { status: 400 });
  }
  const defaultBranch = await detectMainBranch(projPath);
  if (currentBranch === defaultBranch) {
    return NextResponse.json({ detail: `On default branch (${defaultBranch}) — switch to a feature branch first` }, { status: 400 });
  }

  // Push current branch to origin first (gh pr create requires an upstream)
  const pushR = await exec('git', ['-C', projPath, 'push', '-u', 'origin', 'HEAD'], { timeout: 120000 });
  if (pushR.exitCode !== 0) {
    return NextResponse.json({ detail: `Push failed: ${pushR.stderr || pushR.stdout}` }, { status: 500 });
  }

  // Create PR with title/body auto-filled from commits. Pass an explicit --base
  // so gh doesn't guess from origin/HEAD (which may be unset or stale).
  const prR = await exec('gh', ['pr', 'create', '--fill', '--base', defaultBranch], { cwd: projPath, timeout: 60000 });
  if (prR.exitCode !== 0) {
    return NextResponse.json({ detail: prR.stderr || prR.stdout || 'gh pr create failed' }, { status: 500 });
  }

  // Extract PR URL robustly. gh may emit preamble lines containing other pull
  // URLs (e.g. a referenced PR in the commit body) before the real one, so pick
  // the last match rather than the first.
  const urlMatches = prR.stdout.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g);
  const url = urlMatches && urlMatches.length > 0 ? urlMatches[urlMatches.length - 1] : null;
  return NextResponse.json({ url });
}
