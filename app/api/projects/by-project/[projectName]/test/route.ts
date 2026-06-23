import { NextRequest, NextResponse } from 'next/server';
import { startProjectTest } from '@/lib/pipeline/start-test';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  let approveUntrustedPrBranch = false;
  try {
    const body = await request.json();
    approveUntrustedPrBranch = body?.approveUntrustedPrBranch === true;
  } catch {
    // Empty/non-JSON body is fine for the normal button path.
  }
  const r = await startProjectTest(projectName, { approveUntrustedPrBranch });
  if (!r.ok) {
    const errorBody: { detail: string; blocking_job_id?: string } = { detail: r.detail };
    if (r.blockingJobId) errorBody.blocking_job_id = r.blockingJobId;
    return NextResponse.json(errorBody, { status: r.status });
  }
  return NextResponse.json({
    status: 'started',
    job_id: r.jobId,
    pid: r.pid,
    log_path: r.logPath,
    test_cmd: r.testCmd,
  });
}
