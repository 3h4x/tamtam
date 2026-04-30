import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/project-data';
import { exec } from '@/lib/shell';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  // Read porcelain to learn which branch we're on so we can target the fetch.
  const initial = await exec(
    'git',
    ['-C', projPath, 'status', '--porcelain=v2', '--branch'],
    { timeout: 5000 }
  );

  const initialLines = initial.exitCode === 0 ? initial.stdout.split('\n') : [];
  const branchHead = initialLines.find((l) => l.startsWith('# branch.head '))
    ?.slice('# branch.head '.length).trim();
  const branchUpstream = initialLines.find((l) => l.startsWith('# branch.upstream '))
    ?.slice('# branch.upstream '.length).trim();

  // Refresh the upstream ref so behind reflects what's actually on origin.
  // Without this, `git status` reports behind based on the last local fetch,
  // which is often stale when the user pulls/pushes outside TamTam.
  if (branchHead && branchUpstream) {
    const slash = branchUpstream.indexOf('/');
    const remote = slash > 0 ? branchUpstream.slice(0, slash) : 'origin';
    const upstreamBranch = slash > 0 ? branchUpstream.slice(slash + 1) : branchHead;
    await exec(
      'git',
      ['-C', projPath, 'fetch', '--quiet', remote, upstreamBranch],
      { timeout: 10000 },
    );
  }

  const result = await exec(
    'git',
    ['-C', projPath, 'status', '--porcelain=v2', '--branch'],
    { timeout: 5000 }
  );

  let behind = 0;
  let ahead = 0;

  if (result.exitCode === 0) {
    const abLine = result.stdout.split('\n').find((l) => l.startsWith('# branch.ab '));
    if (abLine) {
      const m = abLine.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = parseInt(m[1], 10);
        behind = parseInt(m[2], 10);
      }
    }
  }

  return NextResponse.json({ behind, ahead });
}
