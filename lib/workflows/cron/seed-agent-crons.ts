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
import { Pool } from 'pg';
import type { AgentInput } from '@/lib/scheduling/agent-types';
import { computeNextFire } from '@/lib/workflows/cron/parse-schedule';

export interface SeedDeps {
  /** Loads all enabled scheduled agents from the DB. */
  loadEnabledAgents: () => Promise<AgentInput[]>;
  /** Postgres connection string for graphile-worker. Defaults to
   *  WORKFLOW_POSTGRES_URL ?? DATABASE_URL. */
  connectionString?: string;
  /** Override Date.now for testing. */
  now?: () => number;
  /** Look up existing rows for already-queued `agent-cron-*` jobs so we can
   *  preserve healthy queued fires across restarts. Defaults to a direct
   *  query against `graphile_worker._private_jobs`. */
  loadExistingRunAts?: (jobKeys: string[], connectionString: string) => Promise<Map<string, ExistingAgentCronJob>>;
}

export interface SeedResult {
  enqueued: number;
  skipped: { agentId: string; reason: string }[];
  preserved: number;
}

export interface ExistingAgentCronJob {
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  lockedAt: Date | null;
  isAvailable: boolean;
}

export async function seedAgentCrons(deps: SeedDeps): Promise<SeedResult> {
  const connectionString = resolveConnectionString(deps.connectionString);
  if (!connectionString) {
    return {
      enqueued: 0,
      skipped: [{ agentId: '*', reason: 'no postgres URL' }],
      preserved: 0,
    };
  }
  const now = deps.now ?? Date.now;
  const agents = await deps.loadEnabledAgents();

  // Look up `run_at` for any already-queued cron rows so we can preserve
  // them across restarts. Without this, every Next.js boot would push every
  // agent's next-fire to `now + period`, which means an agent whose period
  // is shorter than the restart interval can never fire (because the row's
  // `run_at` is always overwritten before it arrives).
  const eligible = agents.filter((a) => a.enabled && a.schedule);
  const jobKeys = eligible.map((a) => `agent-cron-${a.id}`);
  let existing = new Map<string, ExistingAgentCronJob>();
  if (jobKeys.length > 0) {
    try {
      const loader = deps.loadExistingRunAts ?? loadExistingRunAtsFromPg;
      existing = await loader(jobKeys, connectionString);
    } catch (err) {
      // Non-fatal: fall back to the legacy "always overwrite" behavior. The
      // worst case is the schedule drift we're trying to prevent, which is
      // strictly better than failing the whole boot pass.
      console.error('[seed-agent-crons] preserve lookup failed:', err);
    }
  }

  let enqueued = 0;
  let preserved = 0;
  const skipped: SeedResult['skipped'] = [];
  const nowMs = now();
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
      const jobKey = `agent-cron-${agent.id}`;
      const nextFromNow = computeNextFire(agent.schedule, agent.id, nowMs);
      const existingJob = existing.get(jobKey);
      const existingRunAt = existingJob?.runAt.getTime();
      if (
        existingRunAt
        && existingJob.attempts === 0
        && existingJob.isAvailable
        && !existingJob.lockedAt
        && existingRunAt > nowMs
        && existingRunAt <= nextFromNow
      ) {
        // The already-queued fire is in the future and no later than the
        // freshly-computed one, and it has no retry/error state to clear —
        // leave it alone. Failed rows are replaced so Graphile resets
        // attempts/last_error on the keyed upsert.
        preserved += 1;
        continue;
      }
      await quickAddJob(
        { connectionString },
        'agent-cron',
        { agentId: agent.id },
        {
          jobKey,
          jobKeyMode: 'replace',
          runAt: new Date(nextFromNow),
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
  return { enqueued, skipped, preserved };
}

async function loadExistingRunAtsFromPg(
  jobKeys: string[],
  connectionString: string,
): Promise<Map<string, ExistingAgentCronJob>> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const { rows } = await pool.query<{
      key: string;
      run_at: Date;
      attempts: number;
      max_attempts: number;
      locked_at: Date | null;
      is_available: boolean;
    }>(
      `
        SELECT key, run_at, attempts, max_attempts, locked_at, is_available
        FROM graphile_worker._private_jobs
        WHERE key = ANY($1::text[])
      `,
      [jobKeys],
    );
    const map = new Map<string, ExistingAgentCronJob>();
    for (const row of rows) {
      if (row.key) {
        map.set(row.key, {
          runAt: row.run_at,
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
          lockedAt: row.locked_at,
          isAvailable: row.is_available,
        });
      }
    }
    return map;
  } finally {
    await pool.end();
  }
}

function resolveConnectionString(override?: string): string | null {
  if (override) return override;
  return process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL ?? null;
}
