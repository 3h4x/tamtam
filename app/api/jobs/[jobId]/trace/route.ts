import { NextRequest, NextResponse } from 'next/server';
import { buildJobTrace } from '@/lib/jobs/job-trace';

// The full story of one work unit (agent run / release / chat): trigger,
// pipeline steps with per-step verdict + log excerpt, work report, files,
// usage, and context. Read-only. Powers the history detail drawer.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params;
  const trace = buildJobTrace(jobId);
  if (!trace) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  return NextResponse.json(trace);
}
