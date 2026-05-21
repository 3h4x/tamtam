import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';

// Fetch and checkout a PR's head branch so Terminal opens on the right branch.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  let body: { branch?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ detail: 'invalid JSON' }, { status: 400 }); }

  const branch = (body.branch ?? '').toString().trim();
  if (!branch) return NextResponse.json({ detail: 'branch required' }, { status: 400 });
  // Reject names that git could parse as a flag or that contain whitespace/null bytes.
  if (branch.startsWith('-') || /\s/.test(branch) || branch.includes('\0')) {
    return NextResponse.json({ detail: 'invalid branch name' }, { status: 400 });
  }

  const currentR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  const currentBranch = currentR.stdout.trim();
  if (currentBranch === branch) {
    return NextResponse.json({ status: 'already-on-branch', branch });
  }

  // Fetch the branch from origin first so local checkout can track it.
  // Capture the result instead of discarding it: when both checkout
  // attempts below fail, the fetch stderr is often the most actionable
  // error (e.g. "couldn't find remote ref ..." when the branch is gone
  // upstream, or a network failure), and silently dropping it forced
  // operators to re-run the command in a terminal to learn why.
  const fetchR = await exec('git', ['-C', projPath, 'fetch', 'origin', branch], { timeout: 15000 });

  // Try local checkout first (branch may already exist), then track from origin.
  const checkoutR = await exec('git', ['-C', projPath, 'checkout', branch], { timeout: 10000 });
  if (checkoutR.exitCode === 0) {
    clearProjectDataCache();
    return NextResponse.json({ status: 'switched', branch });
  }

  const trackR = await exec(
    'git', ['-C', projPath, 'checkout', '-b', branch, `origin/${branch}`],
    { timeout: 10000 },
  );
  if (trackR.exitCode === 0) {
    clearProjectDataCache();
    return NextResponse.json({ status: 'created', branch });
  }

  const reason = (trackR.stderr || checkoutR.stderr || fetchR.stderr || '').trim();
  return NextResponse.json(
    { detail: `Failed to checkout ${branch}: ${reason || 'unknown git error'}` },
    { status: 500 },
  );
}
