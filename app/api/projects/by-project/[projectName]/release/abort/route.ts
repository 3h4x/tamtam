import { NextRequest, NextResponse } from 'next/server';
import { abortActiveRelease } from '@/lib/pipeline/release-abort';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const result = await abortActiveRelease(projectName, { reason: 'user' });
  const { httpStatus, ...body } = result;
  return NextResponse.json(body, { status: httpStatus });
}
