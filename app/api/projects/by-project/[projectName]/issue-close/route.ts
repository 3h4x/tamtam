import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { closeIssue, type CloseIssueReason } from '@/lib/github/close-issue';

const VALID_REASONS = new Set<CloseIssueReason>(['completed', 'not planned']);
const VALID_REASONS_DETAIL = `reason must be one of: ${Array.from(VALID_REASONS).join(', ')}`;

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
  const reasonRaw = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!VALID_REASONS.has(reasonRaw as CloseIssueReason)) {
    return NextResponse.json({ detail: VALID_REASONS_DETAIL }, { status: 400 });
  }
  const comment = typeof body.comment === 'string' ? body.comment : undefined;

  const result = await closeIssue({
    project: projectName,
    projPath,
    number: issueNumber,
    reason: reasonRaw as CloseIssueReason,
    comment,
  });
  if (!result.ok) {
    return NextResponse.json({ detail: result.detail }, { status: result.status });
  }
  return NextResponse.json({ status: 'closed', number: result.number, reason: result.reason, repo: result.repo });
}
