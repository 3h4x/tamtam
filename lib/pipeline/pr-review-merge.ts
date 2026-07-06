import type { JobData } from '@/lib/jobs/types';
import { getVerdict } from '@/lib/jobs/verdict';
import { getProjectPipelineConfig } from '@/lib/jobs/lifecycle-helpers';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getPrAuthorLogin } from '@/lib/github/pr-author';
import { isUserTrusted } from '@/lib/shared/untrusted';
import { launchPrWait, resolvePrTarget } from '@/lib/pipeline/start-pr-wait';

export type PrReviewMergeResult = { launched: boolean; jobId?: string; reason?: string };

/**
 * After a read-only PR-diff review (sourceType 'pr_review') finishes, decide
 * whether to drive that PR to merge. This is the streamlined "finish the PR"
 * path: a per-PR Review that returns LGTM continues into `pr-wait` (which polls
 * CI, enforces the risky-diff gate, merges, and runs post-merge DoD) instead of
 * leaving the operator to click Merge separately.
 *
 * It NEVER touches the working copy the way the release commit/push chain does
 * (the completion hook excludes pr_review from that chain). Every gate here is
 * fail-closed so a Review click can only ever merge a green, trusted-author,
 * auto-merge-enabled PR:
 *   - verdict must be LGTM (a downgraded/unverified-criteria review is not),
 *   - the project must have auto_pr_merge_enabled (opt-in per project),
 *   - the PR author must be trusted (safe_users / trusted_github_users).
 * `pr-wait` itself still enforces CI-green, mergeable, and the high-risk-file
 * refusal, and surfaces a HITL for anything it won't auto-merge.
 */
export async function maybeAutoMergeAfterPrReview(job: JobData): Promise<PrReviewMergeResult> {
  let prNumber: number | undefined;
  try {
    const meta = job.contextMeta ? (JSON.parse(job.contextMeta) as { sourceType?: unknown; prNumber?: unknown }) : {};
    if (meta.sourceType !== 'pr_review') return { launched: false, reason: 'not-pr-review' };
    if (typeof meta.prNumber === 'number' && meta.prNumber > 0) prNumber = meta.prNumber;
  } catch {
    return { launched: false, reason: 'not-pr-review' };
  }
  if (!prNumber) return { launched: false, reason: 'no-pr-number' };

  if (getVerdict(job) !== 'LGTM') return { launched: false, reason: 'verdict-not-lgtm' };

  const cfg = await getProjectPipelineConfig(job.project);
  if (!cfg.autoPrMergeEnabled) return { launched: false, reason: 'auto-merge-disabled' };

  const projPath = resolveProjectPath(job.project);
  if (!projPath) return { launched: false, reason: 'project-not-found' };

  const target = await resolvePrTarget(projPath, prNumber);
  if ('error' in target) return { launched: false, reason: 'resolve-failed' };

  // Author-trust gate: a PR on a public repo can be opened by anyone. Only
  // auto-merge PRs whose author is a trusted user; a null author fails closed.
  const author = await getPrAuthorLogin(target.prRepo, prNumber);
  if (!author || !isUserTrusted(author, projPath)) {
    return { launched: false, reason: 'author-untrusted' };
  }

  const r = launchPrWait(job.project, prNumber, target.prRepo, target.prUrl);
  if ('error' in r) return { launched: false, reason: r.error };
  return { launched: true, jobId: r.jobId };
}
