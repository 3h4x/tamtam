import type { AgentActionList } from '@/lib/agents/action-schema';

export interface AgentActionEligibilityJob {
  kind: string;
  exitCode: number | null;
  ghIssueNumber?: number | null;
}

export type AgentActionEligibility =
  | { ok: true }
  | { ok: false; reason: 'non-zero-exit' | 'unsupported-job-kind' | 'missing-issue-context' | 'issue-mismatch'; detail?: string };

function actionIssueNumber(action: AgentActionList[number]): number | null {
  // `merge-pr` carries the PR number in `prNumber`; its issue linkage (the
  // field that must match the job's chosen issue) is `issue`.
  if (action.type === 'merge-pr') return action.issue;
  return 'number' in action ? action.number : null;
}

export function canExecuteAgentActions(
  job: AgentActionEligibilityJob,
  actions: AgentActionList,
): AgentActionEligibility {
  if (job.exitCode !== 0) {
    return { ok: false, reason: 'non-zero-exit' };
  }

  const issueScoped =
    job.kind === 'agent:issue-cruncher' ||
    (job.kind === 'run' && job.ghIssueNumber != null);
  if (!issueScoped) {
    return { ok: false, reason: 'unsupported-job-kind' };
  }

  // Single pass: short-circuit on first missing-context or mismatch; no
  // intermediate array. The `missing-issue-context` guard is correct — it
  // requires the job to be stamped with the issue it acted on, so a numbered
  // action can be bounded to that issue (the `issue-mismatch` guard). The
  // scheduled issue-cruncher MUST therefore be stamped with its pick_top-chosen
  // issue (see lib/agents/intake-workflow.ts); if it isn't, its actions are
  // (safely) skipped here.
  for (const action of actions) {
    const n = actionIssueNumber(action);
    if (n == null) continue;
    if (job.ghIssueNumber == null) {
      return { ok: false, reason: 'missing-issue-context' };
    }
    if (n !== job.ghIssueNumber) {
      return {
        ok: false,
        reason: 'issue-mismatch',
        detail: `action issue #${n} does not match job issue #${job.ghIssueNumber}`,
      };
    }
  }

  return { ok: true };
}
