import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { resolveGhRepo } from '@/lib/github/repo';
import { db, schema } from '@/lib/db';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  let body: { number?: number; body?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ detail: 'invalid JSON' }, { status: 400 }); }

  const issueNumber = Number(body.number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return NextResponse.json({ detail: 'number required' }, { status: 400 });
  }
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) {
    return NextResponse.json({ detail: 'body required' }, { status: 400 });
  }

  const repo = await resolveGhRepo(projectName, projPath);
  if (!repo) return NextResponse.json({ detail: 'could not determine GitHub repo' }, { status: 422 });

  const r = await exec(
    'gh',
    ['issue', 'comment', String(issueNumber), '--repo', repo, '--body', text],
    { timeout: 15000 },
  );
  if (r.exitCode !== 0) {
    return NextResponse.json({ detail: r.stderr.trim() || 'gh issue comment failed' }, { status: 422 });
  }

  await db.delete(schema.ghIssueDetailCache)
    .where(and(
      eq(schema.ghIssueDetailCache.project, projectName),
      eq(schema.ghIssueDetailCache.number, issueNumber),
    ))
    .execute();

  return NextResponse.json({ status: 'commented', number: issueNumber, repo });
}
