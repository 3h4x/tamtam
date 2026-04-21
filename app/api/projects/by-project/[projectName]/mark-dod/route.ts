import { NextResponse } from 'next/server';
import { startMarkDod } from '@/lib/start-mark-dod';

// Manually run DoD verification for the project's latest issue-linked run.
// Used for debugging and as a "re-check now" button — the release pipeline
// also invokes startMarkDod automatically after review→LGTM.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  try {
    const { projectName } = await params;
    const result = await startMarkDod(projectName);
    if (!result.ok) return NextResponse.json({ detail: result.detail }, { status: result.status });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ detail: `internal error: ${msg}` }, { status: 500 });
  }
}
