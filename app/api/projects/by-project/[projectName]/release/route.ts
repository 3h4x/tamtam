import { NextRequest, NextResponse } from 'next/server';
import { startRelease } from '@/lib/pipeline/start-release';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json().catch(() => ({})) as {
    queue_if_blocked?: unknown;
    source_job_id?: unknown;
  };
  const r = await startRelease(projectName, {
    queueIfBlocked: body.queue_if_blocked === true,
    sourceJobId: typeof body.source_job_id === 'string' ? body.source_job_id : undefined,
  });
  if (!r.ok) {
    const errorBody: { detail: string; blocking_job_id?: string } = { detail: r.detail };
    if (r.blockingJobId) errorBody.blocking_job_id = r.blockingJobId;
    return NextResponse.json(errorBody, { status: r.status });
  }
  if ('status' in r && r.status === 'queued') {
    return NextResponse.json({
      status: 'queued',
      message: r.message,
      blocking_job_id: r.blockingJobId,
    }, { status: 202 });
  }
  return NextResponse.json({
    status: 'started',
    step: r.step,
    job_id: r.jobId,
    release_job_id: r.releaseJobId,
    message: r.message,
  });
}
