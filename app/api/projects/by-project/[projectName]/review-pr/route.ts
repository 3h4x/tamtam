import { NextRequest, NextResponse } from 'next/server';
import { startPrReview } from '@/lib/pipeline/start-pr-review';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
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

  const { prNumber, prTitle, headRef, baseRef } = body as {
    prNumber?: unknown;
    prTitle?: unknown;
    headRef?: unknown;
    baseRef?: unknown;
  };

  // prNumber MUST be a positive integer — `startPrReview` types it as
  // `number` and passes it into a `gh pr view <N>` argv. A non-numeric
  // value would either break the gh call or, if coerced, point at the
  // wrong PR. Reject at the boundary.
  if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) {
    return NextResponse.json(
      { detail: 'prNumber is required and must be a positive integer' },
      { status: 400 },
    );
  }

  const result = await startPrReview(
    projectName,
    prNumber,
    typeof prTitle === 'string' ? prTitle : '',
    typeof headRef === 'string' ? headRef : '',
    typeof baseRef === 'string' ? baseRef : '',
  );
  if (!result.ok) {
    return NextResponse.json({ detail: result.detail }, { status: result.status });
  }
  return NextResponse.json({
    status: 'started',
    job_id: result.jobId,
    pid: result.pid,
    log_path: result.logPath,
  });
}
