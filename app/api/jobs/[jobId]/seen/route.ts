// tamtam
import { NextRequest, NextResponse } from 'next/server';
import { markSeen } from '@/lib/jobs/job-storage';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  if (!markSeen(jobId)) {
    return NextResponse.json({ detail: `job '${jobId}' not found` }, { status: 404 });
  }
  return NextResponse.json({ status: 'ok' });
}
