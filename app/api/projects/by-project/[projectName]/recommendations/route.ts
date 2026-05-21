import { NextRequest, NextResponse } from 'next/server';
import { listRecommendations, updateRecommendationStatus } from '@/lib/recommendations/recommendations';

const VALID_STATUSES = ['open', 'dismissed'] as const;
type RecommendationStatus = (typeof VALID_STATUSES)[number];

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
  let body: { id?: unknown; status?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: 'invalid JSON body' }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  const status = typeof body.status === 'string' ? body.status : '';
  if (!id || !(VALID_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ detail: 'id and valid status (open or dismissed) are required' }, { status: 400 });
  }
  const recommendation = await updateRecommendationStatus(projectName, id, status as RecommendationStatus);
  if (!recommendation) {
    return NextResponse.json({ detail: 'recommendation not found' }, { status: 404 });
  }
  return NextResponse.json({ recommendation });
}
