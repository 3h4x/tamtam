// Convergence guards for the workflow-driven release pipeline.
//
// When `decideNextPhase` returns `{ next: 'fix', from: 'review' }`, the
// orchestrator must check whether the fix loop is actually making progress
// before dispatching another fix iteration. Two checks:
//
//   reviewIsStuck — the current review re-flags the exact same set of
//     findings as a previous review in the same release. Another fix
//     iteration won't break the loop; bail.
//
//   fixContradictsReview — the most recent fix in the same release claimed
//     `Status: fixed` for one or more Finding IDs that the current review is
//     STILL flagging. The model and its own reviewer disagree on whether
//     the finding is closed; another iteration won't help, bail.
//
// Lifted out of `lib/jobs/lifecycle.ts` so the workflow runtime can apply
// the same guardrails. The original lifecycle copies stay in place until
// the legacy chain blocks are deleted (see Phase guardrail-port plan).

import type { JobData } from '@/lib/jobs/types';
import { extractFixClaims, extractFindingIds, findingsIdentity } from '@/lib/pipeline/review-contract';

export interface ReleaseConvergenceDeps {
  /** Walk the project's job cache. Caller passes `listJobs` from the storage
   *  module — kept as a dep so the guards stay pure / testable. */
  listJobs: () => JobData[];
  /** Read a job's parsed log (NDJSON-stripped). Same contract as
   *  `lib/jobs/job-storage` `readParsedLog`. */
  readParsedLog: (job: JobData) => string;
}

/** Stable fingerprint of a review's findings — same hash means same set of
 *  Finding IDs (preferred) or same prose (fallback when the model didn't
 *  emit structured findings). Two reviews with the same fingerprint within
 *  a release indicate the fix loop is not converging. */
export function findingsFingerprint(reviewLogText: string): string {
  const structured = findingsIdentity(reviewLogText);
  if (structured) return `ids:${structured}`;
  let s = reviewLogText.trim();
  const verdictMatch = s.match(/\n[ \t]*Verdict:[^\n]*\s*$/i);
  if (verdictMatch) s = s.slice(0, verdictMatch.index);
  s = s
    .replace(/```[\s\S]*?```/g, '')   // drop fenced code blocks
    .replace(/^[\s]*[-*•]\s+/gm, '')  // strip bullet markers
    .replace(/^#+\s+/gm, '')          // strip markdown headers
    .replace(/\s+/g, ' ')             // collapse whitespace
    .trim()
    .toLowerCase();
  // Cheap non-crypto hash; we only need equality, not security.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

/** True if the current review (assumed NEEDS ATTENTION / DO NOT SHIP) re-
 *  flags the same findings as the most-recent prior review in the same
 *  release. Returns false when no prior review exists or the fingerprints
 *  differ — both indicate the loop is still making progress.
 *
 *  Stand-alone (no releaseId) reviews always return false: there's nothing
 *  to compare against and the workflow runtime never invokes the guard for
 *  unlinked reviews. */
export function reviewIsStuck(currentReview: JobData, deps: ReleaseConvergenceDeps): boolean {
  if (!currentReview.releaseId) return false;
  const reviews = deps
    .listJobs()
    .filter(
      (j) =>
        j.project === currentReview.project &&
        j.kind === 'review' &&
        j.releaseId === currentReview.releaseId &&
        j.id !== currentReview.id &&
        j.exitCode === 0,
    )
    .sort((a, b) => b.startedAt - a.startedAt);
  if (reviews.length === 0) return false;
  const prev = reviews[0];
  try {
    const cur = findingsFingerprint(deps.readParsedLog(currentReview));
    const old = findingsFingerprint(deps.readParsedLog(prev));
    // Treat short / trivial fingerprints as inconclusive — only equal-and-
    // non-trivial fingerprints count as "stuck".
    return cur === old && cur.length > 1;
  } catch {
    return false;
  }
}

/** Outcome of `fixContradictsReview`. When `stuck` is true, `ids` lists the
 *  Finding IDs the prior fix claimed to fix that the current review still
 *  flags — useful for the abort reason / log message. */
export interface FixContradictionResult {
  stuck: boolean;
  ids: string[];
}

/** True when the most-recent successful fix in the same release claimed
 *  `Status: fixed` for at least one Finding ID that the current review is
 *  still flagging. Caller should treat as a hard stop — another iteration
 *  cannot resolve a model/reviewer disagreement. */
export function fixContradictsReview(
  currentReview: JobData,
  deps: ReleaseConvergenceDeps,
): FixContradictionResult {
  if (!currentReview.releaseId) return { stuck: false, ids: [] };
  const fixes = deps
    .listJobs()
    .filter(
      (j) =>
        j.project === currentReview.project &&
        j.kind === 'fix' &&
        j.releaseId === currentReview.releaseId &&
        j.exitCode === 0 &&
        j.startedAt < currentReview.startedAt,
    )
    .sort((a, b) => b.startedAt - a.startedAt);
  if (fixes.length === 0) return { stuck: false, ids: [] };
  const fixJob = fixes[0];
  try {
    const claimedFixed = new Set(
      extractFixClaims(deps.readParsedLog(fixJob))
        .filter((c) => c.status === 'fixed')
        .map((c) => c.id),
    );
    if (claimedFixed.size === 0) return { stuck: false, ids: [] };
    const stillFlagged = extractFindingIds(deps.readParsedLog(currentReview));
    const overlap = stillFlagged.filter((id) => claimedFixed.has(id));
    if (overlap.length === 0) return { stuck: false, ids: [] };
    return { stuck: true, ids: overlap };
  } catch {
    return { stuck: false, ids: [] };
  }
}
