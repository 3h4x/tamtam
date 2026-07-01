// Detect an existing OPEN pull request that already implements a given issue,
// so the issue-cruncher can verify-and-merge it instead of re-implementing.
//
// Linkage signals, in priority order:
//   1. PR head branch is the issue's canonical `fix/issue-<n>[-slug]` branch
//   2. PR declares a GitHub closing reference to the issue
//      (`closingIssuesReferences`, populated from "Closes #<n>" etc.)
//   3. PR body text has a close/fix/resolve keyword pointing at `#<n>`
// Signal (1)/(2) are authoritative; (3) is the fallback for PRs that used a
// keyword GitHub didn't parse into a structured reference.

import { exec } from '@/lib/shared/shell';
import { resolveGhRepo } from '@/lib/github/repo';

export interface IssuePrMatch {
  number: number;
  branch: string;
  url: string;
}

interface GhPr {
  number: number;
  headRefName: string;
  url: string;
  body: string;
  isDraft: boolean;
  closingIssuesReferences?: { number: number }[];
}

function bodyReferencesIssue(body: string, issueNumber: number): boolean {
  // "closes #12", "Fixed #12", "resolve #12" — GitHub's own closing-keyword set.
  const re = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i');
  return re.test(body || '');
}

/**
 * Return the open PR that implements `issueNumber`, or null. Prefers a
 * branch-name / closing-reference match; skips draft PRs (not ready to merge).
 */
export async function findOpenPrForIssue(opts: {
  project: string;
  projPath: string;
  issueNumber: number;
  issueBranch: string;
}): Promise<IssuePrMatch | null> {
  const { project, projPath, issueNumber, issueBranch } = opts;
  const repo = await resolveGhRepo(project, projPath);
  if (!repo) return null;

  const res = await exec(
    'gh',
    ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100',
      '--json', 'number,headRefName,url,body,isDraft,closingIssuesReferences'],
    { timeout: 30000 },
  );
  if (res.exitCode !== 0) return null;

  let prs: GhPr[];
  try {
    prs = JSON.parse(res.stdout) as GhPr[];
  } catch {
    return null;
  }

  const branchPrefix = `fix/issue-${issueNumber}`;
  let keywordMatch: GhPr | null = null;
  for (const pr of prs) {
    if (pr.isDraft) continue;
    const head = pr.headRefName || '';
    // Authoritative: canonical issue branch, or exact-N branch prefix.
    if (head === issueBranch || head === branchPrefix || head.startsWith(`${branchPrefix}-`)) {
      return { number: pr.number, branch: head, url: pr.url };
    }
    // Authoritative: structured closing reference.
    if ((pr.closingIssuesReferences ?? []).some((r) => r.number === issueNumber)) {
      return { number: pr.number, branch: head, url: pr.url };
    }
    // Fallback: unparsed close keyword in the body — remember but keep scanning
    // for a stronger signal first.
    if (!keywordMatch && bodyReferencesIssue(pr.body, issueNumber)) {
      keywordMatch = pr;
    }
  }
  if (keywordMatch) {
    return { number: keywordMatch.number, branch: keywordMatch.headRefName, url: keywordMatch.url };
  }
  return null;
}
