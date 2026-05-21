import { NextRequest, NextResponse } from 'next/server';
import { listJobs, readLog } from '@/lib/jobs/job-storage';
import type { JobData } from '@/lib/jobs/job-storage';

interface ContinuePayload {
  sessionId: string | null;
  provider: string | null;
  prompt: string;
  unverifiedCount: number;
  hasContext: boolean;
}

function issueStamped(job: Pick<JobData, 'ghIssueNumber'> | null | undefined): job is JobData & { ghIssueNumber: number } {
  return !!job && typeof job.ghIssueNumber === 'number' && Number.isFinite(job.ghIssueNumber);
}

function issueScopedMarkDodSourceNumber(
  job: { ghIssueNumber?: number | null; contextMeta?: string | null },
): number | null {
  if (!job.contextMeta) return null;
  try {
    const meta = JSON.parse(job.contextMeta) as { sourceType?: string; sourceNumber?: number };
    if (meta.sourceType !== 'issue') return null;
    if (typeof meta.sourceNumber === 'number' && Number.isFinite(meta.sourceNumber)) {
      return meta.sourceNumber;
    }
    return job.ghIssueNumber ?? null;
  } catch {
    return null;
  }
}

function isIssueScopedMarkDod(job: { ghIssueNumber?: number | null; contextMeta?: string | null }, issueNumber: number): boolean {
  return issueScopedMarkDodSourceNumber(job) === issueNumber;
}

// Lookup bundle: hoist the byId map + the per-project subset once at the
// route entry and pass through to the legacy-inference helpers. Without
// this, each candidate mark-dod row in the project would rebuild `byId`
// (O(N) over the global ~25k-job cache) AND re-filter the global cache by
// project — O(M × N) overall, dominated by the global rebuilds. With the
// bundle the helpers operate on the per-project subset only.
interface ContinueIssueLookup {
  byId: Map<string, JobData>;
  projectJobs: JobData[];
}

function inferLegacyMarkDodIssueFromLineage(job: JobData, lookup: ContinueIssueLookup): number | null {
  const seen = new Set<string>();
  let cursor = job.parentJobId ? lookup.byId.get(job.parentJobId) ?? null : null;

  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (issueStamped(cursor)) return cursor.ghIssueNumber;
    cursor = cursor.parentJobId ? lookup.byId.get(cursor.parentJobId) ?? null : null;
  }

  if (job.releaseId) {
    const releaseScopedIssue = lookup.projectJobs
      .filter(
        (candidate) =>
          candidate.releaseId === job.releaseId &&
          issueStamped(candidate),
      )
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (releaseScopedIssue) return releaseScopedIssue.ghIssueNumber ?? null;
  }

  return null;
}

const LEGACY_CONTEXT_KINDS = new Set(['run', 'fix']);

function inferLegacyMarkDodIssueByTime(job: JobData, lookup: ContinueIssueLookup): number | null {
  return lookup.projectJobs
    .filter(
      (candidate) =>
        LEGACY_CONTEXT_KINDS.has(candidate.kind) &&
        candidate.ghIssueNumber != null &&
        candidate.startedAt <= job.startedAt,
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0]?.ghIssueNumber ?? null;
}

function matchesIssueMarkDod(job: JobData, issueNumber: number, lookup: ContinueIssueLookup): boolean {
  if (isIssueScopedMarkDod(job, issueNumber)) return true;
  if (job.ghIssueNumber === issueNumber && !job.contextMeta) return true;
  if (job.ghIssueNumber != null) return false;
  return (
    inferLegacyMarkDodIssueFromLineage(job, lookup) === issueNumber ||
    inferLegacyMarkDodIssueByTime(job, lookup) === issueNumber
  );
}

/**
 * Build the "Continue work" payload for an issue:
 *
 * 1. Find the most recent Claude run/fix job tagged with this issue
 *    (`gh_issue_number`) and grab its `session_id` + originating provider so
 *    the next run can `--resume` into the same CLI conversation.
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
  // Build lookup once: byId for parent-chain walks (lineage), projectJobs
  // for per-project filters. Both helpers used by `matchesIssueMarkDod`
  // read these structures instead of re-scanning the global cache.
  const projectJobs = allJobs.filter((j) => j.project === projectName);
  const lookup: ContinueIssueLookup = {
    byId: new Map(allJobs.map((j) => [j.id, j])),
    projectJobs,
  };

  // Most recent Claude run that ran for this issue. We accept run/fix kinds
  // — both store a session_id and either is a valid resume target.
  const claudeKindsForResume = new Set(['run', 'fix']);
  const lastClaudeForIssue = projectJobs
    .filter(j =>
      claudeKindsForResume.has(j.kind)
      && j.ghIssueNumber === issueNumber
      && j.sessionId
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

  // Most recent mark-dod for this issue. mark-dod rows now persist their own
  // source issue/PR metadata, so a newer verification pass for some other
  // issue in the same project cannot leak its checklist into this prompt.
  // Older rows predate that stamp, so fall back to the latest issue-linked
  // run/fix context that existed before the legacy mark-dod fired.
  const lastMarkDod = projectJobs
    .filter(j => j.kind === 'mark-dod' && matchesIssueMarkDod(j, issueNumber, lookup))
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
    provider: lastClaudeForIssue?.provider ?? null,
    prompt,
    unverifiedCount: unverified.length,
    hasContext: !!lastClaudeForIssue,
  };
  return NextResponse.json(payload);
}
