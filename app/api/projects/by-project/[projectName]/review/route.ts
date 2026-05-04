import { NextRequest, NextResponse } from 'next/server';
import { startProjectReview } from '@/lib/pipeline/start-review';
import { isCliProvider } from '@/lib/usage/cli-providers';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const preferredProviderHeader = request.headers.get('x-tamtam-provider-preferred');
  const result = await startProjectReview(projectName, {
    preferredProvider: isCliProvider(preferredProviderHeader) ? preferredProviderHeader : null,
  });
  if (!result.ok) {
    const errorBody: { detail: string; blocking_job_id?: string } = { detail: result.detail };
    if (result.blockingJobId) errorBody.blocking_job_id = result.blockingJobId;
    return NextResponse.json(errorBody, { status: result.status });
  }
  return NextResponse.json({
    status: 'started',
    job_id: result.jobId,
    pid: result.pid,
    log_path: result.logPath,
  });
}
