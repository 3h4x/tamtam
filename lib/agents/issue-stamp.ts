/**
 * Pure parsing of the issue-cruncher prerequisite output into the issue-stamp
 * fields that get written onto the job row (`ghIssueNumber` / `ghIssueTitle` /
 * `ghIssueRepo`). The scheduled issue-cruncher SELECTS its issue at runtime via
 * the `pick_top` prereq, so the job is never pre-stamped; stamping is what lets
 * the action orchestrator (lib/agents/action-eligibility) dispatch the
 * issue-close/comment/label actions instead of skipping them as
 * "missing-issue-context".
 */
export interface IssueStamp {
  number: number;
  title?: string;
  repo?: string;
}

/**
 * Parse the raw prereq stdout (the `pick_top=1` JSON payload). Returns a stamp
 * only when a numeric `chosenIssue` is present; returns null for non-JSON
 * output, a null/absent `chosenIssue`, or any other shape — callers should then
 * leave the job unstamped (its actions are safely skipped downstream).
 */
export function parseIssueStamp(stdout: string | null | undefined): IssueStamp | null {
  let parsed:
    | { chosenIssue?: number | null; issue?: { title?: string; url?: string } }
    | null;
  try {
    parsed = JSON.parse(stdout || 'null');
  } catch {
    return null;
  }
  if (typeof parsed?.chosenIssue !== 'number') return null;

  const stamp: IssueStamp = { number: parsed.chosenIssue };
  if (parsed.issue?.title) stamp.title = parsed.issue.title;
  const repoMatch = parsed.issue?.url?.match(/github\.com\/([^/]+\/[^/]+)\/issues/);
  if (repoMatch) stamp.repo = repoMatch[1];
  return stamp;
}
