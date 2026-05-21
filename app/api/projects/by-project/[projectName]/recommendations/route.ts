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
  // Defensive parse: a malformed body used to bubble up as a 500. Matches
  // the convention from review-pr / changes / create-pr / skills routes.
  let body: { id?: unknown; status?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: 'invalid JSON body' }, { status: 400 });
  }
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
