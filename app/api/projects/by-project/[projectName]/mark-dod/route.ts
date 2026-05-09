import { NextResponse } from 'next/server';
import { startMarkDod } from '@/lib/pipeline/start-mark-dod';

// Manually run DoD verification for the project's latest issue-linked run.
// Used for debugging and as a "re-check now" button — the release pipeline
// also invokes startMarkDod automatically after review→LGTM.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  try {
    const { projectName } = await params;
    // Optional override from the IssuesTab DoD badge — caller already knows
    // the PR/issue number and bypasses the implicit lookup.
    let override: { issueNumber?: number; prNumber?: number; repo?: string } | undefined;
    try {
      const text = await req.text();
      if (text) {
        const body = JSON.parse(text) as { issue_number?: number; pr_number?: number; repo?: string };
        if (body.repo && (body.issue_number || body.pr_number)) {
          override = {
            issueNumber: body.issue_number,
            prNumber: body.pr_number,
            repo: body.repo,
          };
        }
      }
    } catch { /* no body or invalid JSON — fall through to implicit lookup */ }
    const result = await startMarkDod(projectName, { ...override, mode: 'standalone' });
    if (!result.ok) return NextResponse.json({ detail: result.detail }, { status: result.status });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ detail: `internal error: ${msg}` }, { status: 500 });
  }
}
