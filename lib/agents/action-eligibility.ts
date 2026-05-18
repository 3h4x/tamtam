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

  const issueNumbers = actions
    .map(actionIssueNumber)
    .filter((n): n is number => n != null);
  if (issueNumbers.length === 0) {
    return { ok: true };
  }

  if (job.ghIssueNumber == null) {
    return { ok: false, reason: 'missing-issue-context' };
  }

  const mismatched = issueNumbers.find((n) => n !== job.ghIssueNumber);
  if (mismatched != null) {
    return {
      ok: false,
      reason: 'issue-mismatch',
      detail: `action issue #${mismatched} does not match job issue #${job.ghIssueNumber}`,
    };
  }

  return { ok: true };
}
