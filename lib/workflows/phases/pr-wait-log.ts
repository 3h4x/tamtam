// Shared helpers for the pr-wait phase workflow's steps. Kept in their own
// module so the step bodies stay focused on workflow control flow.

import { getJob } from '@/lib/jobs/job-storage';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';

/** Append a line to a pr-wait job's log file, looked up by jobId. */
export function appendLogForJob(jobId: string, line: string): void {
  const job = getJob(jobId);
  if (!job?.logPath) return;
  try {
    appendRedactedFileSync(job.logPath, line);
  } catch {
    /* log-write failures are non-fatal */
  }
}

/**
 * Walk the parent chain from the pr-wait job to find an ancestor stamped
 * with `ghIssueNumber` + `ghIssueRepo`. Used post-merge so the DoD
 * verification reads the linked ISSUE's acceptance criteria (which carry
 * the checklist) instead of the PR body (which typically only contains
 * "Closes #N").
 */
export function findIssueTargetForPostMergeDod(
  prWaitJobId: string,
): { issueNumber: number; repo: string } | null {
  const job = getJob(prWaitJobId);
  if (!job) return null;
  const seen = new Set<string>();
  let cursor: string | null = job.parentJobId ?? null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const ancestor = getJob(cursor);
    if (!ancestor) break;
    if (ancestor.ghIssueNumber != null && ancestor.ghIssueRepo) {
      return { issueNumber: ancestor.ghIssueNumber, repo: ancestor.ghIssueRepo };
    }
    cursor = ancestor.parentJobId ?? null;
  }
  return null;
}
