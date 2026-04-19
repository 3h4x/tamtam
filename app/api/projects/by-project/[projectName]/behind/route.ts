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
