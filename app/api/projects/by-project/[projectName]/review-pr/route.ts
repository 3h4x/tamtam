import { NextRequest, NextResponse } from 'next/server';
import { startPrReview } from '@/lib/start-pr-review';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json();
  const { prNumber, prTitle, headRef, baseRef } = body;

  if (!prNumber) {
    return NextResponse.json({ detail: 'prNumber is required' }, { status: 400 });
  }

  const result = await startPrReview(projectName, prNumber, prTitle ?? '', headRef ?? '', baseRef ?? '');
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
