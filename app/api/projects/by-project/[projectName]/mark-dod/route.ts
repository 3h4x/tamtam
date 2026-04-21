import { NextResponse } from 'next/server';

// Manually run DoD verification for the project's latest issue-linked run.
// Used for debugging and as a "re-check now" button — the release pipeline
// also invokes startMarkDod automatically after review→LGTM.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  console.log('[mark-dod route] entered');
  try {
    const { projectName } = await params;
    console.log('[mark-dod route] project:', projectName);
    const mod = await import('@/lib/start-mark-dod');
    console.log('[mark-dod route] imported', Object.keys(mod));
    const result = await mod.startMarkDod(projectName);
    console.log('[mark-dod route] result:', result);
    if (!result.ok) return NextResponse.json({ detail: result.detail }, { status: result.status });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    console.error('[mark-dod route] crash:', msg);
    return NextResponse.json({ detail: `internal error: ${msg}` }, { status: 500 });
  }
}
