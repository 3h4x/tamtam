import { NextRequest, NextResponse } from 'next/server';
import { syncJobToProjectBoard, isBoardSyncRateLimitError } from '@/lib/github/project-board';
import { getJob } from '@/lib/jobs/job-storage';

export async function POST(_request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ detail: 'Job not found' }, { status: 404 });
  }
  if (job.finishedAt == null) {
    return NextResponse.json({ detail: 'Only finished jobs can be synced manually.' }, { status: 409 });
  }

  try {
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Failed to sync job to GitHub board.';
    // Map errors to accurate HTTP status:
    //   - rate-limit cooldown → 429 so clients can back off
    //   - config-state messages (board disabled / not fully configured / missing status options)
    //     all start with the "GitHub board sync " prefix → 409 conflict
    //   - everything else (gh CLI failure, network) → 502 upstream
    // Order matters: the rate-limit predicate must run before the prefix
    // check, otherwise rate-limit errors (which also start with the prefix)
    // would collapse into 409 and hide the back-off signal.
    let status: number;
    if (isBoardSyncRateLimitError(error)) status = 429;
    else if (detail.startsWith('GitHub board sync ')) status = 409;
    else status = 502;
    return NextResponse.json({ detail }, { status });
  }
}
