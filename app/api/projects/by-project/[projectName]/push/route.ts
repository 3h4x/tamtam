import { NextRequest, NextResponse } from 'next/server';
import { launchProjectPush } from '@/lib/start-push';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const result = launchProjectPush(projectName);
  if ('error' in result) {
    return NextResponse.json({ detail: result.error }, { status: 404 });
  }
  return NextResponse.json({ status: 'started', job_id: result.jobId });
}
