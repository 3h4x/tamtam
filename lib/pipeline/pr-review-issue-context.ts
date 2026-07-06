import { readIssueBody } from '@/lib/github/edit-issue-body';
import { parseLinkedIssue } from '@/lib/github/issue-row-enrichment';
import { extractCriteria } from '@/lib/pipeline/mark-dod-criteria';

export interface PrReviewIssueContext {
  issueNumber: number;
  /** Unchecked acceptance-criteria texts from the linked issue body. */
  criteria: string[];
}

/**
 * Resolve the acceptance criteria a PR review should verify against, by walking
 * PR body → linked issue (`Closes #N`) → the issue's unchecked `- [ ]` DoD
 * checklist. Best-effort: returns null when there is no linked issue or no
 * unchecked criteria (nothing to gate on), or on any lookup failure — a PR
 * review must still run on the diff alone. When it returns criteria, the review
 * prompt injects them and the completion hook downgrades a LGTM to NEEDS
 * ATTENTION for any criterion the reviewer marks unverified — so an
 * issue-linked PR cannot auto-merge without meeting its DoD.
 */
export async function fetchPrReviewIssueContext(
  projPath: string,
  repo: string,
  prNumber: number,
): Promise<PrReviewIssueContext | null> {
  try {
    const pr = await readIssueBody({ projPath, repo, number: prNumber, kind: 'pr' });
    if (!pr.ok) return null;

    const issueNumber = parseLinkedIssue(pr.body);
    if (!issueNumber) return null;

    const issue = await readIssueBody({ projPath, repo, number: issueNumber, kind: 'issue' });
    if (!issue.ok) return null;

    const criteria = extractCriteria(issue.body).map((c) => c.text);
    if (criteria.length === 0) return null;

    return { issueNumber, criteria };
  } catch {
    return null;
  }
}
