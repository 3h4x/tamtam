import { NextRequest, NextResponse } from 'next/server';
import { getJob, jobToDict, readLog, probeJobStatus } from '@/lib/job-storage';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ detail: `job '${jobId}' not found` }, { status: 404 });
  }
  await probeJobStatus(job);
  const data = jobToDict(job);
  data.log = readLog(job);
  return NextResponse.json(data);
}
