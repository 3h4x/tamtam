import { NextResponse } from 'next/server';
import { summarizeOpenRecommendations } from '@/lib/recommendations/recommendations';

// Cross-project summary used by the global header chip + the
// `/recommendations` page. Counts only `status = 'open'` rows; dismissed and
// applied recs do not contribute. Cheap to call (single GROUP BY) and safe
// to poll on a 60s interval from the client.
export async function GET() {
  return NextResponse.json(await summarizeOpenRecommendations());
}
