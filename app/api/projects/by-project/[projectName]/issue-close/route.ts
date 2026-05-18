import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { resolveGhRepo } from '@/lib/github/repo';
import { db, schema } from '@/lib/db';

const VALID_REASONS = new Set(['completed', 'not planned']);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  let body: { number?: number; reason?: string; comment?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ detail: 'invalid JSON' }, { status: 400 }); }

  const issueNumber = Number(body.number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return NextResponse.json({ detail: 'number required' }, { status: 400 });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!VALID_REASONS.has(reason)) {
    return NextResponse.json({ detail: `reason must be one of: ${Array.from(VALID_REASONS).join(', ')}` }, { status: 400 });
  }
  const comment = typeof body.comment === 'string' ? body.comment.trim() : '';

  const repo = await resolveGhRepo(projectName, projPath);
  if (!repo) return NextResponse.json({ detail: 'could not determine GitHub repo' }, { status: 422 });

  const args = ['issue', 'close', String(issueNumber), '--repo', repo, '--reason', reason];
  if (comment) args.push('--comment', comment);

  const r = await exec('gh', args, { timeout: 15000 });
  if (r.exitCode !== 0) {
    return NextResponse.json({ detail: r.stderr.trim() || 'gh issue close failed' }, { status: 422 });
  }

  // Invalidate both detail (for this number) and list (closing changes the open set).
  await Promise.all([
    db.delete(schema.ghIssueDetailCache)
      .where(and(
        eq(schema.ghIssueDetailCache.project, projectName),
        eq(schema.ghIssueDetailCache.number, issueNumber),
      ))
      .execute(),
    db.delete(schema.ghIssuesCache)
      .where(eq(schema.ghIssuesCache.project, projectName))
      .execute(),
  ]);

  return NextResponse.json({ status: 'closed', number: issueNumber, reason, repo });
}
