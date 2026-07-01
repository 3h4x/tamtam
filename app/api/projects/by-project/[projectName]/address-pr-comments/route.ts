import { NextRequest, NextResponse } from 'next/server';
import { startPrCommentFix } from '@/lib/pipeline/start-pr-comment-fix';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
) {
  const { projectName } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: 'invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ detail: 'body must be an object' }, { status: 400 });
  }

  const { pr } = body as { pr?: unknown };
  // `pr` flows into a `gh api .../pulls/<pr>/comments` argv; require a positive
  // integer so a non-numeric value can't retarget the wrong PR.
  if (typeof pr !== 'number' || !Number.isInteger(pr) || pr <= 0) {
    return NextResponse.json(
      { detail: 'pr is required and must be a positive integer' },
      { status: 400 },
    );
  }

  try {
    const result = await startPrCommentFix(projectName, pr);
    if (!result.ok) {
      return NextResponse.json(
        { detail: result.detail, blockingJobId: result.blockingJobId },
        { status: result.status },
      );
    }
    return NextResponse.json({
      status: 'started',
      job_id: result.jobId,
      pid: result.pid,
      log_path: result.logPath,
    });
  } catch (err) {
    console.error('[address-pr-comments] failed:', err);
    const detail = err instanceof Error ? err.message : 'address PR comments failed';
    return NextResponse.json({ detail }, { status: 500 });
  }
}
