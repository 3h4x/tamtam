import { NextRequest, NextResponse } from 'next/server';
import { startRelease } from '@/lib/start-release';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const r = await startRelease(projectName);
  if (!r.ok) {
    const errorBody: { detail: string; blocking_job_id?: string } = { detail: r.detail };
    if (r.blockingJobId) errorBody.blocking_job_id = r.blockingJobId;
    return NextResponse.json(errorBody, { status: r.status });
  }
  return NextResponse.json({
    status: 'started',
    step: r.step,
    job_id: r.jobId,
    release_job_id: r.releaseJobId,
    message: r.message,
  });
}
