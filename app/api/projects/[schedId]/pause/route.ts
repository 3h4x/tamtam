import { NextRequest, NextResponse } from 'next/server';
import { getImproveConfig } from '@/lib/scheduling';
import { pauseAll } from '@/lib/launchagent';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ schedId: string }> }
) {
  const { schedId } = await params;
  const { projects } = getImproveConfig();
  if (!projects[schedId]) {
    return NextResponse.json({ detail: `project '${schedId}' not found` }, { status: 404 });
  }
  await pauseAll([schedId]);
  return NextResponse.json({ status: 'ok' });
}
