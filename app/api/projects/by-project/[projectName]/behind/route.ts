import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  // Use light git primitives instead of `git status --porcelain=v2 --branch`.
  // Porcelain walks every tracked file (~100-300 ms on a large dirty repo)
  // when all we need is the current branch's upstream + the ahead/behind
  // count. `rev-parse @{u}` is O(1) and `rev-list --count --left-right`
  // touches only the divergent commits.
  const upstreamR = await exec(
    'git',
    ['-C', projPath, 'rev-parse', '--abbrev-ref', '@{u}'],
    { timeout: 5000 },
  );
  // No upstream tracking branch (detached HEAD, brand-new local branch,
  // missing remote, ...) — nothing to be behind/ahead of. Return zeros so
  // the UI doesn't render a misleading badge.
  if (upstreamR.exitCode !== 0) {
    return NextResponse.json({ behind: 0, ahead: 0 });
  }
  const upstream = upstreamR.stdout.trim();
  if (!upstream) {
    return NextResponse.json({ behind: 0, ahead: 0 });
  }

  // Refresh the upstream ref so behind/ahead reflect what's actually on
  // origin. Without this, we'd report the last local fetch state, which
  // goes stale fast when the user pulls/pushes outside TamTam.
  const slash = upstream.indexOf('/');
  const remote = slash > 0 ? upstream.slice(0, slash) : 'origin';
  const upstreamBranch = slash > 0 ? upstream.slice(slash + 1) : upstream;
  await exec(
    'git',
    ['-C', projPath, 'fetch', '--quiet', remote, upstreamBranch],
    { timeout: 10000 },
  );

  // `HEAD...@{u}` in `rev-list --count --left-right` returns
  // `<ahead>\t<behind>` on a single line. Cheaper than re-scanning the
  // worktree just to read porcelain's `# branch.ab` line.
  const countR = await exec(
    'git',
    ['-C', projPath, 'rev-list', '--count', '--left-right', 'HEAD...@{u}'],
    { timeout: 5000 },
  );

  let ahead = 0;
  let behind = 0;
  if (countR.exitCode === 0) {
    const m = countR.stdout.trim().match(/^(\d+)\s+(\d+)/);
    if (m) {
      ahead = parseInt(m[1], 10);
      behind = parseInt(m[2], 10);
    }
  }

  return NextResponse.json({ behind, ahead });
}
