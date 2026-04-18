import { NextRequest, NextResponse } from 'next/server';
import { startProjectTest } from '@/lib/start-test';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const r = await startProjectTest(projectName);
  if (!r.ok) {
    return NextResponse.json({ detail: r.detail }, { status: r.status });
  }
  return NextResponse.json({
    status: 'started',
    job_id: r.jobId,
    pid: r.pid,
    log_path: r.logPath,
    test_cmd: r.testCmd,
  });
}
