import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { realPathStaysInsideProject, resolveProjectRelativePath } from '@/lib/shared/path-containment';
import { exec } from '@/lib/shared/shell';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;

  const file = request.nextUrl.searchParams.get('file');
  if (!file) return NextResponse.json({ detail: 'file param required' }, { status: 400 });

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  // Path-traversal guard. Without this, the untracked branch below would
  // run `git diff --no-index -- /dev/null <file>` against any
  // filesystem path the request supplied (`?file=/etc/passwd` or
  // `?file=../../etc/passwd`), turning this read-only diff endpoint into
  // an arbitrary file disclosure. Normalize the request relative to the
  // project root and reject anything that escapes.
  const requested = resolveProjectRelativePath(projPath, file);
  if (!requested) {
    return NextResponse.json({ detail: 'file outside project' }, { status: 400 });
  }
  const { absolutePath, relativePath } = requested;

  // Symlink check must run BEFORE any git invocation — a tracked symlink
  // resolving outside the project would otherwise let `git diff HEAD --
  // <symlink>` disclose the target's content (depends on `core.symlinks`).
  if (!realPathStaysInsideProject(projPath, absolutePath)) {
    return NextResponse.json({ detail: 'file outside project' }, { status: 400 });
  }

  const tracked = await exec(
    'git',
    ['-C', projPath, 'ls-files', '--error-unmatch', '--', relativePath],
    { timeout: 5000 }
  );

  if (tracked.exitCode === 0) {
    const diff = await exec(
      'git',
      ['-C', projPath, 'diff', 'HEAD', '--', relativePath],
      { timeout: 15000 }
    );
    return NextResponse.json({ diff: diff.stdout, untracked: false });
  }

  const diff = await exec(
    'git',
    ['-C', projPath, 'diff', '--no-index', '--', '/dev/null', relativePath],
    { timeout: 15000 }
  );
  return NextResponse.json({ diff: diff.stdout, untracked: true });
}
