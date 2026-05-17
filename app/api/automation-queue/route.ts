import { NextRequest, NextResponse } from 'next/server';
import { listAutomationQueue } from '@/lib/workflows/automation-queue';

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get('project') ?? undefined;
  const items = await listAutomationQueue(project);
  return NextResponse.json({ items });
}
