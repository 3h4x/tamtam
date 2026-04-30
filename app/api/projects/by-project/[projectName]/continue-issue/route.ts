import { NextRequest, NextResponse } from 'next/server';
import { listJobs, readLog } from '@/lib/jobs/job-storage';

interface ContinuePayload {
  sessionId: string | null;
  prompt: string;
  unverifiedCount: number;
  hasContext: boolean;
}

/**
 * Build the "Continue work" payload for an issue:
 *
 * 1. Find the most recent Claude run/fix job tagged with this issue
 *    (`gh_issue_number`) and grab its `session_id` so the next run can
 *    `--resume` into the same Claude conversation.
 *
 * 2. Find the most recent `mark-dod` job for the same issue and parse its
 *    log for the `[unverified]` lines that mark-dod itself wrote — those are
 *    the boxes still open. We re-use the on-disk log instead of GitHub
 *    because mark-dod's verdicts are richer than just checkbox state and
 *    include evidence notes about *why* each item is open.
 *
 * 3. Compose a focused prompt that lists only the open items so Claude
 *    doesn't waste tokens re-exploring the parts already done.
 *
 * GET /api/projects/by-project/[name]/continue-issue?issue_number=9
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
) {
  const { projectName } = await params;
  const { searchParams } = new URL(request.url);
  const issueNumber = parseInt(searchParams.get('issue_number') ?? '', 10);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    return NextResponse.json({ detail: 'issue_number is required' }, { status: 400 });
  }

  const allJobs = listJobs();

  // Most recent Claude run that ran for this issue. We accept run/fix kinds
  // — both store a session_id and either is a valid resume target.
  const claudeKindsForResume = new Set(['run', 'fix']);
  const lastClaudeForIssue = allJobs
    .filter(j =>
      j.project === projectName
      && claudeKindsForResume.has(j.kind)
      && j.ghIssueNumber === issueNumber
      && j.sessionId
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

  // Most recent mark-dod for this issue (regardless of project — issue numbers
  // are repo-scoped but `mark-dod` rows are stamped with the project).
  const lastMarkDod = allJobs
    .filter(j => j.project === projectName && j.kind === 'mark-dod')
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

  // Parse the unverified items from the mark-dod log. Lines look like:
  //   # [unverified] 2.1 useTokenAllowance hook
  //   #   evidence: <one-liner>
  const unverified: { text: string; evidence: string }[] = [];
  if (lastMarkDod) {
    let logText = '';
    try { logText = readLog(lastMarkDod); } catch { /* fall through */ }
    const lines = logText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^#\s+\[unverified\]\s+(.+)$/);
      if (!m) continue;
      const text = m[1].trim();
      const next = lines[i + 1] ?? '';
      const ev = next.match(/^#\s+evidence:\s*(.*)$/);
      unverified.push({ text, evidence: ev ? ev[1].trim() : '' });
    }
  }

  let prompt: string;
  if (unverified.length > 0) {
    const list = unverified.map((u, i) => `${i + 1}. ${u.text}${u.evidence ? `\n   (last verdict: ${u.evidence})` : ''}`).join('\n');
    prompt = `Continue work on GitHub issue #${issueNumber}. The acceptance criteria below are still unverified after the last DoD check — implement them on the current branch.

${list}

Work through them one by one. Edit files directly. Don't redo anything that already passed verification. After you finish, run the project's tests and linter locally so the next review/DoD pass converges.`;
  } else {
    // No mark-dod history (or the log got pruned). Fall back to a generic
    // "pick up where you left off" prompt; Claude has the full session
    // context via --resume so it can re-orient on its own.
    prompt = `Continue work on GitHub issue #${issueNumber}. Resume from where the last session ended — figure out which acceptance criteria are still open by checking the issue body and the codebase, then implement them. Edit files directly; do not commit.`;
  }

  const payload: ContinuePayload = {
    sessionId: lastClaudeForIssue?.sessionId ?? null,
    prompt,
    unverifiedCount: unverified.length,
    hasContext: !!lastClaudeForIssue,
  };
  return NextResponse.json(payload);
}
