// graphile-worker task handler for the per-agent cron pattern. Each enabled
// scheduled agent has one queued `agent-cron` job at a time (deduplicated by
// `jobKey = agent-cron-${agentId}`); when graphile fires it at `runAt`,
// this handler:
//
//   1. Loads the live agent definition (skips if disabled / removed).
//   2. Runs prereq gates (project paused, project archived, branch lock,
//      pending duplicate run for this agent).
//   3. Starts the agent-run workflow via the existing intake path.
//   4. Re-enqueues itself at the next fire time.
//
// Self-recursion via re-enqueue is the closest equivalent of the plan's
// `sleep(periodMs)` pattern — `workflow/api` doesn't expose `sleep`, so
// we use the queue layer's native `runAt` instead.
//
// Boot wiring: `lib/workflows/cron/seed-agent-crons.ts` schedules the
// initial enqueue per enabled agent on Next.js startup.

import type { Helpers, JobHelpers } from 'graphile-worker';
import type { AgentInput } from '@/lib/scheduling/agent-types';
import { computeNextFire } from '@/lib/workflows/cron/parse-schedule';

export interface AgentCronPayload {
  agentId: string;
  /** When set on an orchestrator-enqueued boost fire, the agent run uses
   *  this model tier instead of the agent's configured default. Self-
   *  scheduled re-enqueues do NOT propagate this — only the boost fire it
   *  was attached to runs at the elevated tier. */
  modelOverride?: 'fast' | 'normal' | 'smart';
}

export interface AgentCronDeps {
  /** Resolves the live agent metadata. Return null if the agent has been
   *  disabled or removed since last enqueue — the task no-ops. */
  loadAgent: (agentId: string) => Promise<AgentInput | null>;
  /** Per-project gates: pause toggle, archive flag, branch lock, etc.
   *  Returns a non-null reason string when the run should be skipped this
   *  cycle (re-enqueue still happens; we just don't dispatch). */
  prereqSkipReason: (agent: AgentInput) => Promise<string | null>;
  /** Dispatch the agent-run workflow. Returns the run id (telemetry only).
   *  `modelOverride` (orchestrator boost) replaces the agent's stored model
   *  for this fire only. */
  startAgentRun: (
    agent: AgentInput,
    modelOverride?: 'fast' | 'normal' | 'smart',
  ) => Promise<string | null>;
  /** Dispatch a system (kind='system') agent through its internal handler
   *  instead of the LLM-CLI workflow. Returns null when no handler is
   *  registered for the given name — caller will fall back to skipping. */
  runSystemAgent?: (agent: AgentInput) => Promise<void>;
  /** Re-enqueue this same task with the per-agent jobKey at the next
   *  fire time (idempotent — replaces any already-queued one). */
  enqueueNextFire: (agentId: string, runAt: Date) => Promise<void>;
}

// Re-check window when a fire is skipped due to a transient blocker.
// Pushing the next fire by the full schedule interval after a transient
// skip means a 30-min agent that was momentarily blocked (jobs paused
// during a rebuild, branch not-default for ~1 min while a PR merges)
// has to wait another 30 min — and the operator sees "due now" in the
// UI while nothing is queued. Short retry window catches the blocker
// clearing without piling on real work.
const TRANSIENT_RETRY_MS = 60_000;

// Reasons that resolve on their own within seconds-to-minutes.
// `prereqSkipReason` returns free-form strings; substring matching here
// is intentionally loose so a small wording change doesn't break the
// fast-retry path. One combined regex (case-insensitive) replaces the
// previous OR chain of six toLowerCase()+includes() calls.
const TRANSIENT_SKIP_RE =
  /jobs paused|pr-wait in flight|non-default branch|pipeline_lock|release pipeline is running|behind origin\//i;

function isTransientSkip(reason: string): boolean {
  return TRANSIENT_SKIP_RE.test(reason);
}

/** Pure handler — no graphile-worker / db imports here so it stays
 *  vitest-friendly. The thin wrapper at the bottom of this file binds it
 *  to the real helpers + db. */
export async function handleAgentCron(
  payload: AgentCronPayload,
  deps: AgentCronDeps,
  now: () => number = Date.now,
): Promise<{ status: 'dispatched' | 'skipped' | 'disabled'; runId?: string | null; reason?: string }> {
  const agent = await deps.loadAgent(payload.agentId);
  if (!agent || !agent.enabled) {
    // Don't re-enqueue — caller will get nothing and the chain terminates.
    return { status: 'disabled', reason: agent ? 'disabled' : 'not found' };
  }
  const skipReason = await deps.prereqSkipReason(agent);
  // Re-enqueue regardless of dispatch outcome — the schedule keeps ticking
  // even when individual fires are skipped (paused project, etc.).
  if (!agent.schedule) {
    // Agent was just disabled (schedule cleared) — terminate the chain.
    return { status: 'disabled', reason: 'no schedule' };
  }
  // Transient skip → retry in ~60s so the system catches up the moment
  // the blocker clears. Anything else (including a successful dispatch
  // or an unknown skip reason) advances to the next scheduled tick.
  const nextFireMs = skipReason && isTransientSkip(skipReason)
    ? now() + TRANSIENT_RETRY_MS
    : computeNextFire(agent.schedule, agent.id, now());
  await deps.enqueueNextFire(agent.id, new Date(nextFireMs));
  if (skipReason) {
    return { status: 'skipped', reason: skipReason };
  }
  if (agent.kind === 'system') {
    if (!deps.runSystemAgent) {
      return { status: 'skipped', reason: 'no system handler bound' };
    }
    await deps.runSystemAgent(agent);
    return { status: 'dispatched', runId: null, reason: 'system' };
  }
  const runId = await deps.startAgentRun(agent, payload.modelOverride);
  return { status: 'dispatched', runId };
}

/** graphile-worker task entrypoint — bound when seedAgentCrons starts the
 *  worker. Wired in lib/workflows/cron/seed-agent-crons.ts. */
export type AgentCronTask = (payload: AgentCronPayload, helpers: JobHelpers) => Promise<void>;

export function createAgentCronTask(deps: AgentCronDeps): AgentCronTask {
  return async (payload, helpers) => {
    try {
      const result = await handleAgentCron(payload, deps);
      helpers.logger.info(`agent-cron ${payload.agentId} → ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    } catch (err) {
      helpers.logger.error(`agent-cron ${payload.agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
      // Re-throw so graphile-worker records the failure + applies its own
      // retry policy. The next attempt will re-resolve the agent and might
      // succeed on a transient error.
      throw err;
    }
  };
}

// Re-export for ergonomic import from boot helper.
export type { JobHelpers, Helpers };
