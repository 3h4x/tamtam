import { NextResponse } from 'next/server';
import { listAllOpenRecommendations } from '@/lib/recommendations/recommendations';

// Cross-project list of every open recommendation, newest-first. Powers the
// global `/recommendations` page. Per-project endpoint
// (`/api/projects/by-project/[name]/recommendations`) still owns project
// scoping and PATCH; this route is read-only and never returns dismissed /
// applied rows.
export async function GET() {
  return NextResponse.json({ recommendations: await listAllOpenRecommendations() });
}
