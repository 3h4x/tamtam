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
        const body = JSON.parse(text) as { issue_number?: unknown; pr_number?: unknown; repo?: unknown };
        // Strict type checks: numbers must be finite positive integers,
        // repo must be a non-empty string. Truthy-only was permissive
        // enough that a typo'd `issue_number: "5"` would flow through as
        // `"5"` and crash deep inside startMarkDod's gh invocation.
        const repo = typeof body.repo === 'string' && body.repo.trim().length > 0 ? body.repo.trim() : null;
        const issueNumber = typeof body.issue_number === 'number' && Number.isInteger(body.issue_number) && body.issue_number > 0
          ? body.issue_number
          : null;
        const prNumber = typeof body.pr_number === 'number' && Number.isInteger(body.pr_number) && body.pr_number > 0
          ? body.pr_number
          : null;
        if (repo && (issueNumber || prNumber)) {
          override = {
            issueNumber: issueNumber ?? undefined,
            prNumber: prNumber ?? undefined,
            repo,
          };
        }
      }
    } catch { /* no body or invalid JSON — fall through to implicit lookup */ }
    const result = override ? await startMarkDod(projectName, override) : await startMarkDod(projectName);
    if (!result.ok) return NextResponse.json({ detail: result.detail }, { status: result.status });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ detail: `internal error: ${msg}` }, { status: 500 });
  }
}
