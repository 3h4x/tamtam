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
  /** Drop agent-cron orphan rows that hit max_attempts (graphile-worker
   *  never GCs these). Defaults to a direct DELETE on
   *  `graphile_worker._private_jobs`. */
  sweepDeadOrphans?: (connectionString: string) => Promise<void>;
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

  // Sweep failed-and-stuck orphan rows. graphile-worker keeps a copy of every
  // row that hit max_attempts forever (no built-in GC). After a schema-changing
  // migration that breaks the agent-cron loader query, the worker burns through
  // retries and parks a dead row per agent — these never fire, but they
  // accumulate forever and confuse health queries. Boot is a safe place to
  // drop them: their max-attempts state means graphile-worker has already
  // given up on them, and the keyed `agent-cron-<id>` row carries the live
  // schedule.
  try {
    const sweeper = deps.sweepDeadOrphans ?? sweepDeadOrphansFromPg;
    await sweeper(connectionString);
  } catch (err) {
    console.error('[seed-agent-crons] dead-orphan sweep failed:', err);
  }

  // Fan out the per-agent enqueue. Each `quickAddJob` writes a distinct
  // row keyed by `agent-cron-${agent.id}`, so they don't contend on the
  // same Postgres row lock. At boot with N agents the sequential `await`
  // chain was N serial round-trips; `Promise.allSettled` collapses that
  // to ~max(per-row).
  type AgentOutcome =
    | { kind: 'enqueued' }
    | { kind: 'preserved' }
    | { kind: 'skipped'; reason: string };
  const nowMs = now();
  const outcomes = await Promise.all(
    agents.map(async (agent): Promise<{ agentId: string; outcome: AgentOutcome }> => {
      if (!agent.enabled) {
        return { agentId: agent.id, outcome: { kind: 'skipped', reason: 'disabled' } };
      }
      if (!agent.schedule) {
        return { agentId: agent.id, outcome: { kind: 'skipped', reason: 'no schedule' } };
      }
      try {
        const jobKey = `agent-cron-${agent.id}`;
        const nextFromNow = computeNextFire(agent.schedule, agent.id, nowMs);
        const existingJob = existing.get(jobKey);
        const existingRunAt = existingJob?.runAt.getTime();
        const healthy = existingJob
          && typeof existingRunAt === 'number'
          && existingJob.attempts === 0
          && existingJob.isAvailable
          && !existingJob.lockedAt;
        if (healthy && existingRunAt! > nowMs && existingRunAt! <= nextFromNow) {
          // Already-queued fire in the future, no retry/error state to
          // clear — leave alone. Failed rows are replaced so Graphile
          // resets attempts/last_error on the keyed upsert.
          return { agentId: agent.id, outcome: { kind: 'preserved' } };
        }
        // Past-due rows and unhealthy rows are replaced with the fresh
        // schedule-derived fire time. This clears stale retry state and
        // avoids preserving missed runs forever across restarts.
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
        return { agentId: agent.id, outcome: { kind: 'enqueued' } };
      } catch (err) {
        return {
          agentId: agent.id,
          outcome: { kind: 'skipped', reason: `enqueue failed: ${err instanceof Error ? err.message : String(err)}` },
        };
      }
    }),
  );

  let enqueued = 0;
  let preserved = 0;
  const skipped: SeedResult['skipped'] = [];
  for (const { agentId, outcome } of outcomes) {
    if (outcome.kind === 'enqueued') enqueued += 1;
    else if (outcome.kind === 'preserved') preserved += 1;
    else skipped.push({ agentId, reason: outcome.reason });
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

async function sweepDeadOrphansFromPg(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    // (1) Unkeyed retry copies that graphile-worker has already given up on
    // (max_attempts reached, not currently locked). These never re-fire on
    // their own and would accumulate indefinitely without GC.
    await pool.query(`
      DELETE FROM graphile_worker._private_jobs j
      USING graphile_worker._private_tasks t
      WHERE j.task_id = t.id
        AND t.identifier = 'agent-cron'
        AND j.attempts >= j.max_attempts
        AND j.locked_at IS NULL
        AND j.key IS NULL
    `);
    // (2) Keyed `agent-cron-agent-<id>` rows whose agent has been deleted
    // or disabled in the `agents` table. The keyed agent-cron-task handler
    // already terminates the chain when `loadAgent` returns null/disabled
    // (no re-enqueue), but the existing row sits in the queue table until
    // graphile-worker prunes it on its own schedule (typically days). The
    // seed pass then sees the future-dated row, decides preservation
    // doesn't apply, and SHOULD overwrite — but if `enabled=false` causes
    // the agent to be excluded from `loadEnabledAgents`, the row is never
    // touched and effectively becomes immortal. Sweep them here so the
    // queue accurately reflects live agents only. File-based agents
    // (`agent-cron-file:proj:name`) are intentionally left alone — they
    // have their own lifecycle outside the `agents` DB table.
    try {
      await pool.query(`
        DELETE FROM graphile_worker._private_jobs j
        USING graphile_worker._private_tasks t
        WHERE j.task_id = t.id
          AND t.identifier = 'agent-cron'
          AND j.locked_at IS NULL
          AND j.key LIKE 'agent-cron-agent-%'
          AND replace(j.key, 'agent-cron-', '') NOT IN (
            SELECT id FROM agents WHERE enabled AND schedule IS NOT NULL AND schedule != ''
          )
      `);
    } catch (err) {
      // 42P01 = undefined_table: agents table doesn't exist yet on a fresh DB
      // (migrations haven't run). Skip silently — there are no orphan rows to
      // sweep on a brand-new schema.
      if ((err as { code?: string }).code !== '42P01') throw err;
    }
    // (3) Keyed rows scheduled absurdly far in the future (more than 60
    // days out). The cron task should never produce such a value — every
    // supported schedule unit caps at 30 days. A row with `run_at > now()
    // + 60d` is a corruption marker (e.g. `computeNextFire` once received
    // a malformed schedule, or the agent was disabled when the row was
    // last touched so the seed pass couldn't overwrite it). This sweep
    // runs inside the seed pass — the enqueue loop that follows will
    // re-create rows for any live agent, with proper run_at, via
    // `quickAddJob` (the deleted row's key is now free).
    await pool.query(`
      DELETE FROM graphile_worker._private_jobs j
      USING graphile_worker._private_tasks t
      WHERE j.task_id = t.id
        AND t.identifier = 'agent-cron'
        AND j.locked_at IS NULL
        AND j.key IS NOT NULL
        AND j.run_at > NOW() + INTERVAL '60 days'
    `);
  } finally {
    await pool.end();
  }
}

function resolveConnectionString(override?: string): string | null {
  if (override) return override;
  return process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL ?? null;
}
