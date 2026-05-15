// Boot helper: for every enabled scheduled agent, enqueue an `agent-cron`
// graphile-worker job with `jobKey = agent-cron-${agentId}` and the next
// fire time. Idempotent — `jobKey` collisions update the existing row
// instead of inserting a duplicate, so re-boots don't pile up cron jobs.
//
// This is the cron-side equivalent of the in-memory scheduler's
// `reinstallAgents()` boot pass. It runs once on Next.js startup. The
// agent-cron-task handler (lib/workflows/cron/agent-cron-task.ts) handles
// re-enqueuing itself after each fire, so the chain self-perpetuates
// until the agent is disabled.
//
// Connection string comes from `WORKFLOW_POSTGRES_URL` if set (the same
// DB the workflow runtime uses), falling back to `DATABASE_URL`.

import { quickAddJob } from 'graphile-worker';
import type { AgentInput } from '@/lib/scheduling/internal-scheduler';
import { computeNextFire } from '@/lib/workflows/cron/parse-schedule';

export interface SeedDeps {
  /** Loads all enabled scheduled agents from the DB. */
  loadEnabledAgents: () => Promise<AgentInput[]>;
  /** Postgres connection string for graphile-worker. Defaults to
   *  WORKFLOW_POSTGRES_URL ?? DATABASE_URL. */
  connectionString?: string;
  /** Override Date.now for testing. */
  now?: () => number;
}

export interface SeedResult {
  enqueued: number;
  skipped: { agentId: string; reason: string }[];
}

export async function seedAgentCrons(deps: SeedDeps): Promise<SeedResult> {
  const connectionString = resolveConnectionString(deps.connectionString);
  if (!connectionString) {
    return { enqueued: 0, skipped: [{ agentId: '*', reason: 'no postgres URL' }] };
  }
  const now = deps.now ?? Date.now;
  const agents = await deps.loadEnabledAgents();
  let enqueued = 0;
  const skipped: SeedResult['skipped'] = [];
  for (const agent of agents) {
    if (!agent.enabled) {
      skipped.push({ agentId: agent.id, reason: 'disabled' });
      continue;
    }
    if (!agent.schedule) {
      skipped.push({ agentId: agent.id, reason: 'no schedule' });
      continue;
    }
    try {
      const runAt = new Date(computeNextFire(agent.schedule, agent.id, now()));
      await quickAddJob(
        { connectionString },
        'agent-cron',
        { agentId: agent.id },
        {
          jobKey: `agent-cron-${agent.id}`,
          jobKeyMode: 'replace',
          runAt,
          maxAttempts: 5,
        },
      );
      enqueued += 1;
    } catch (err) {
      skipped.push({
        agentId: agent.id,
        reason: `enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { enqueued, skipped };
}

function resolveConnectionString(override?: string): string | null {
  if (override) return override;
  return process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL ?? null;
}
