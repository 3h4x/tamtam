import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/auth';
import { resolveProjectPath } from '@/lib/project-data';
import { exec } from '@/lib/shell';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;
  const { projectName } = await params;

  const file = request.nextUrl.searchParams.get('file');
  if (!file) return NextResponse.json({ detail: 'file param required' }, { status: 400 });

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const tracked = await exec(
    'git',
    ['-C', projPath, 'ls-files', '--error-unmatch', '--', file],
    { timeout: 5000 }
  );

  if (tracked.exitCode === 0) {
    const diff = await exec(
      'git',
      ['-C', projPath, 'diff', 'HEAD', '--', file],
      { timeout: 15000 }
    );
    return NextResponse.json({ diff: diff.stdout, untracked: false });
  }

  const diff = await exec(
    'git',
    ['-C', projPath, 'diff', '--no-index', '--', '/dev/null', file],
    { timeout: 15000 }
  );
  return NextResponse.json({ diff: diff.stdout, untracked: true });
}
