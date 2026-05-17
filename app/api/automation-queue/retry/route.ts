import { NextRequest, NextResponse } from 'next/server';
import { retryAutomationQueueProject } from '@/lib/workflows/automation-queue';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { project?: unknown };
  if (typeof body.project !== 'string' || body.project.trim() === '') {
    return NextResponse.json({ detail: 'project is required' }, { status: 400 });
  }
  const result = await retryAutomationQueueProject(body.project);
  return NextResponse.json(result);
}
