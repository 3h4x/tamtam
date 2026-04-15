import { NextRequest, NextResponse } from 'next/server';
import { readJobLogs } from '@/lib/log-persistence';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  try {
    const frames = readJobLogs(jobId);
    return NextResponse.json({ logs: frames, count: frames.length });
  } catch (e: any) {
    return NextResponse.json({ logs: null, error: e.message });
  }
}
