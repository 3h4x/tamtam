import { NextRequest, NextResponse } from 'next/server';
import { listRecommendations, updateRecommendationStatus } from '@/lib/recommendations/recommendations';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
) {
  const { projectName } = await params;
  return NextResponse.json({ recommendations: await listRecommendations(projectName) });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
) {
  const { projectName } = await params;
  const body = await request.json();
  const id = typeof body.id === 'string' ? body.id : '';
  const status = typeof body.status === 'string' ? body.status : '';
  if (!id || !['open', 'dismissed'].includes(status)) {
    return NextResponse.json({ detail: 'id and valid status (open or dismissed) are required' }, { status: 400 });
  }
  const recommendation = await updateRecommendationStatus(projectName, id, status as 'open' | 'dismissed');
  if (!recommendation) {
    return NextResponse.json({ detail: 'recommendation not found' }, { status: 404 });
  }
  return NextResponse.json({ recommendation });
}
