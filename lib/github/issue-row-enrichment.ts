import type { JobData } from '@/lib/jobs/types';
import { getVerdict } from '@/lib/jobs/job-storage';
import { extractCriteria } from '@/lib/pipeline/mark-dod-criteria';

// Per-row gate/context data computed server-side from the in-memory jobs
// cache + the issue bodies the list fetch already returns. Folding this into
// the issues response replaces the per-row `continue-issue` / `pr-gates`
// request fan-out (one HTTP call per open issue and PR) with a single pass.

export type GateState = 'pass' | 'fail' | 'warn' | 'none';
export interface PrGates {
  issueNumber: number | null;
  tests: GateState;
  review: GateState;
  dod: GateState;
  dodSummary: string | null;
}

// run/fix jobs both persist a session_id and are valid `--resume` targets, so
// either kind counts as resumable context for the "Continue" badge.
const CLAUDE_RESUME_KINDS = new Set(['run', 'fix']);

// Parse "Closes #N" / "Fixes #N" / "Resolves #N" (case insensitive) from a PR
// body — that's how a PR ties back to its acceptance-criteria gate.
export function parseLinkedIssue(body: string | null | undefined): number | null {
  if (!body) return null;
  const m = body.match(/\b(?:close[sd]?|fixe?[sd]?|resolve[sd]?)\s+#(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// DoD state from a GitHub issue/PR body: count unchecked acceptance criteria
// against checked ones. Kept identical to the previous per-request gh path so
// the badge reads the same, just sourced from the already-fetched body.
export function computeDodFromBody(
  body: string | null | undefined,
): { state: GateState; summary: string | null } {
  const text = body ?? '';
  const unchecked = extractCriteria(text).length;
  const checked = (text.match(/^\s*[-*]\s+\[x\]/gim) ?? []).length;
  const total = checked + unchecked;
  if (total === 0) return { state: 'none', summary: 'no DoD' };
  if (unchecked === 0) return { state: 'pass', summary: `${checked}/${total} DoD` };
  return { state: 'warn', summary: `${checked}/${total} DoD` };
}

// Latest finished job of `kind` linked to this issue via `gh_issue_number`.
function latestForIssue(projectJobs: JobData[], issueNumber: number, kind: string): JobData | undefined {
  let best: JobData | undefined;
  for (const j of projectJobs) {
    if (j.kind !== kind || j.ghIssueNumber !== issueNumber || j.finishedAt == null) continue;
    if (!best || (j.finishedAt ?? 0) > (best.finishedAt ?? 0)) best = j;
  }
  return best;
}

// Fall back to any recent completion of `kind` for the project — used when the
// job wasn't tagged with an issue number (e.g. release pipeline steps).
function latestAny(projectJobs: JobData[], kind: string): JobData | undefined {
  let best: JobData | undefined;
  for (const j of projectJobs) {
    if (j.kind !== kind || j.finishedAt == null) continue;
    if (!best || (j.finishedAt ?? 0) > (best.finishedAt ?? 0)) best = j;
  }
  return best;
}

// Compute the tests / review / dod gate triple for a PR from the project's
// job slice plus a pre-resolved DoD state (derived from the linked issue body).
export function computePrGates(
  projectJobs: JobData[],
  issueNumber: number | null,
  dod: { state: GateState; summary: string | null },
): PrGates {
  let tests: GateState = 'none';
  let review: GateState = 'none';

  if (issueNumber != null && Number.isFinite(issueNumber)) {
    const testJob = latestForIssue(projectJobs, issueNumber, 'test') ?? latestAny(projectJobs, 'test');
    if (testJob) tests = testJob.exitCode === 0 ? 'pass' : 'fail';

    const reviewJob = latestForIssue(projectJobs, issueNumber, 'review') ?? latestAny(projectJobs, 'review');
    if (reviewJob) {
      if (reviewJob.exitCode !== 0) review = 'fail';
      else {
        const v = getVerdict(reviewJob);
        if (v === 'LGTM') review = 'pass';
        else if (v === 'NEEDS ATTENTION') review = 'warn';
        else if (v === 'DO NOT SHIP') review = 'fail';
        else review = 'warn';
      }
    }
  }

  return { issueNumber: issueNumber ?? null, tests, review, dod: dod.state, dodSummary: dod.summary };
}

// Whether a resumable provider session exists for this issue — drives the
// "Continue" vs "Work on" badge without a per-row lookup.
export function issueHasContext(projectJobs: JobData[], issueNumber: number): boolean {
  return projectJobs.some(
    (j) => CLAUDE_RESUME_KINDS.has(j.kind) && j.ghIssueNumber === issueNumber && !!j.sessionId,
  );
}
