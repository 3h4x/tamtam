import { NextRequest, NextResponse } from 'next/server';
import { startProjectReview } from '@/lib/start-review';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const result = await startProjectReview(projectName);
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
