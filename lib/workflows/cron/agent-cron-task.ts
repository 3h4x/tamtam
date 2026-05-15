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
}

export interface AgentCronDeps {
  /** Resolves the live agent metadata. Return null if the agent has been
   *  disabled or removed since last enqueue — the task no-ops. */
  loadAgent: (agentId: string) => Promise<AgentInput | null>;
  /** Per-project gates: pause toggle, archive flag, branch lock, etc.
   *  Returns a non-null reason string when the run should be skipped this
   *  cycle (re-enqueue still happens; we just don't dispatch). */
  prereqSkipReason: (agent: AgentInput) => Promise<string | null>;
  /** Dispatch the agent-run workflow. Returns the run id (telemetry only). */
  startAgentRun: (agent: AgentInput) => Promise<string | null>;
  /** Re-enqueue this same task with the per-agent jobKey at the next
   *  fire time (idempotent — replaces any already-queued one). */
  enqueueNextFire: (agentId: string, runAt: Date) => Promise<void>;
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
  const nextFireMs = computeNextFire(agent.schedule, agent.id, now());
  await deps.enqueueNextFire(agent.id, new Date(nextFireMs));
  if (skipReason) {
    return { status: 'skipped', reason: skipReason };
  }
  const runId = await deps.startAgentRun(agent);
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
