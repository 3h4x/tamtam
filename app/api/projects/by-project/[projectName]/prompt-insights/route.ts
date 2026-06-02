import { NextRequest, NextResponse } from 'next/server';
import { computePromptInsights } from '@/lib/jobs/prompt-insights';

// Window cap is generous (90d) so historical drift is visible; default is 7d
// to match what the operator usually wants on the project overview ("recent
// runs"). Anything beyond 90d is rejected because the aggregates start to
// hide regressions inside the noise.
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 90;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
) {
  const { projectName } = await params;
  const url = new URL(request.url);
  const rawDays = url.searchParams.get('days');
  let days = DEFAULT_WINDOW_DAYS;
  if (rawDays !== null) {
    if (!/^\d+$/.test(rawDays)) {
      return NextResponse.json(
        { error: `days must be an integer between 1 and ${MAX_WINDOW_DAYS}` },
        { status: 400 },
      );
    }
    const parsed = Number(rawDays);
    if (parsed < 1 || parsed > MAX_WINDOW_DAYS) {
      return NextResponse.json(
        { error: `days must be an integer between 1 and ${MAX_WINDOW_DAYS}` },
        { status: 400 },
      );
    }
    days = parsed;
  }

  try {
    const insights = await computePromptInsights(projectName, days);
    return NextResponse.json(insights);
  } catch (err) {
    console.error('[prompt-insights] failed for', projectName, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'unknown error' },
      { status: 500 },
    );
  }
}
