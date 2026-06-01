import { NextRequest, NextResponse } from 'next/server';
import { listAllOpenRecommendations, listAllResolvedRecommendations } from '@/lib/recommendations/recommendations';

// Cross-project recommendation list, newest-first. Powers the global
// `/recommendations` page. Read-only; the per-project endpoint
// (`/api/projects/by-project/[name]/recommendations`) owns PATCH/scoping.
//
//   GET /api/recommendations               → open (Unresolved tab)
//   GET /api/recommendations?state=history → resolved/dismissed/applied (History tab)
export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get('state');
  const recommendations = state === 'history'
    ? await listAllResolvedRecommendations()
    : await listAllOpenRecommendations();
  return NextResponse.json({ recommendations });
}
