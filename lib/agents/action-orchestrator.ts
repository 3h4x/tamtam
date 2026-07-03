// Dispatch a parsed agent-action list to the matching server-side helpers.
//
// Called from `lib/jobs/lifecycle.ts` `markDone` after a sandboxed agent
// finishes — the agent's emitted action block (parsed by
// `action-block-parser.ts`) is handed here and each entry is dispatched
// serially to the same helpers used by the HTTP routes. Per-action errors
// are recorded but never abort the loop: a failed comment must not block
// a queued close.

import type { AgentActionList } from '@/lib/agents/action-schema';
import { closeIssue } from '@/lib/github/close-issue';
import { commentIssue } from '@/lib/github/comment-issue';
import { labelIssue } from '@/lib/github/label-issue';
import { writeIssueBody } from '@/lib/github/edit-issue-body';
import { checkoutDefault } from '@/lib/git/checkout-default';
import { resolveGhRepo } from '@/lib/github/repo';
import { mergePullRequest } from '@/lib/github/merge-pr';
import { resolvePrWaitHitlForMergedPr } from '@/lib/jobs/resolve-pr-wait-hitl';

export interface OrchestratorInput {
  project: string;
  projPath: string;
  jobId: string;
  actions: AgentActionList;
}

export interface OrchestratorActionError {
  index: number;
  type: string;
  detail: string;
}

export interface OrchestratorResult {
  executed: number;
  errors: OrchestratorActionError[];
}

export async function runAgentActions(input: OrchestratorInput): Promise<OrchestratorResult> {
  const { project, projPath, jobId, actions } = input;
  const errors: OrchestratorActionError[] = [];
  let executed = 0;

  // Lazy-resolve repo: only the `issue-edit-body` action needs it directly;
  // the other helpers look it up internally. Cache here in case multiple
  // edit-body actions arrive in one batch.
  let cachedRepo: string | null | undefined;
  const getRepo = async (): Promise<string | null> => {
    if (cachedRepo !== undefined) return cachedRepo;
    cachedRepo = await resolveGhRepo(project, projPath);
    return cachedRepo;
  };

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    try {
      switch (action.type) {
        case 'issue-close': {
          const r = await closeIssue({
            project, projPath,
            number: action.number,
            reason: action.reason,
            comment: action.comment,
          });
          if (r.ok) {
            executed += 1;
            console.log(`[agent-actions] ${jobId} #${action.number} issue-close ok (${r.reason})`);
          } else {
            errors.push({ index: i, type: action.type, detail: r.detail });
            console.warn(`[agent-actions] ${jobId} #${action.number} issue-close error (${r.status}): ${r.detail}`);
          }
          break;
        }
        case 'issue-comment': {
          const r = await commentIssue({
            project, projPath,
            number: action.number,
            body: action.body,
          });
          if (r.ok) {
            executed += 1;
            console.log(`[agent-actions] ${jobId} #${action.number} issue-comment ok`);
          } else {
            errors.push({ index: i, type: action.type, detail: r.detail });
            console.warn(`[agent-actions] ${jobId} #${action.number} issue-comment error (${r.status}): ${r.detail}`);
          }
          break;
        }
        case 'issue-label': {
          const r = await labelIssue({
            project, projPath,
            number: action.number,
            addLabels: action.addLabels,
            removeLabels: action.removeLabels,
          });
          if (r.ok) {
            executed += 1;
            console.log(`[agent-actions] ${jobId} #${action.number} issue-label ok (+${r.addLabels.length}/-${r.removeLabels.length})`);
          } else {
            errors.push({ index: i, type: action.type, detail: r.detail });
            console.warn(`[agent-actions] ${jobId} #${action.number} issue-label error (${r.status}): ${r.detail}`);
          }
          break;
        }
        case 'issue-edit-body': {
          const repo = await getRepo();
          if (!repo) {
            const detail = 'could not determine GitHub repo';
            errors.push({ index: i, type: action.type, detail });
            console.warn(`[agent-actions] ${jobId} #${action.number} issue-edit-body error: ${detail}`);
            break;
          }
          const r = await writeIssueBody({
            projPath, repo,
            number: action.number,
            kind: action.kind,
            body: action.body,
          });
          if (r.ok) {
            executed += 1;
            console.log(`[agent-actions] ${jobId} #${action.number} issue-edit-body ok (${action.kind})`);
          } else {
            errors.push({ index: i, type: action.type, detail: r.detail });
            console.warn(`[agent-actions] ${jobId} #${action.number} issue-edit-body error: ${r.detail}`);
          }
          break;
        }
        case 'merge-pr': {
          const r = await mergePullRequest({
            project, projPath,
            prNumber: action.prNumber,
            mergeMethod: action.mergeMethod,
          });
          if (r.ok) {
            executed += 1;
            // A completed merge resolves any outstanding pr-wait HITL for this
            // PR, so the inbox manual-merge card clears instead of lingering
            // (same fix as the operator inbox/Issues-tab merge path). Skip when
            // we only ENABLED auto-merge (checks pending) — the PR has not
            // landed, so its HITL must stay until it actually merges.
            if (r.merged) resolvePrWaitHitlForMergedPr(project, action.prNumber);
            console.log(`[agent-actions] ${jobId} PR#${action.prNumber} merge-pr ok (issue #${action.issue})`);
          } else {
            errors.push({ index: i, type: action.type, detail: r.detail });
            console.warn(`[agent-actions] ${jobId} PR#${action.prNumber} merge-pr error (${r.status}): ${r.detail}`);
          }
          break;
        }
        case 'checkout-default': {
          const r = await checkoutDefault({ project });
          if (r.ok) {
            executed += 1;
            console.log(`[agent-actions] ${jobId} checkout-default ok (${r.status} → ${r.branch})`);
          } else {
            errors.push({ index: i, type: action.type, detail: r.detail });
            console.warn(`[agent-actions] ${jobId} checkout-default error (${r.status}): ${r.detail}`);
          }
          break;
        }
        default: {
          // Discriminated union exhaustiveness — `action` is `never` here
          // when the union is exhausted. Cast to a known shape for logging
          // so a future action variant added to the schema but not the
          // switch surfaces as a per-action error rather than a crash.
          const unknownAction = action as { type: string };
          errors.push({ index: i, type: unknownAction.type, detail: `unknown action type: ${unknownAction.type}` });
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errors.push({ index: i, type: action.type, detail });
      console.error(`[agent-actions] ${jobId} ${action.type} threw: ${detail}`);
    }
  }

  return { executed, errors };
}
