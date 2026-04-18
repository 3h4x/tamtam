import { NextRequest, NextResponse } from 'next/server';
import { startFixFromJob } from '@/lib/start-fix';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const r = await startFixFromJob(jobId);
  if (!r.ok) return NextResponse.json({ detail: r.detail }, { status: r.status });
  return NextResponse.json({ status: 'started', job_id: r.jobId, pid: r.pid });
}
