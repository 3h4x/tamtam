// Read agent cron queue state directly from graphile-worker so the
// agents API can surface the *actual* next-fire time (and per-agent
// skip telemetry) instead of estimating from `lastRunAt + interval`.
//
// The legacy in-memory scheduler exposed `schedulerEntry.nextFireMs` to
// the AgentsTab; that scheduler was retired when graphile-cron took over
// and the UI has been guessing ever since. After a skipped fire the
// re-enqueue can sit minutes past `lastRunAt + interval`, so the UI
// shows "due now" while the queue says "fires in 14m". This module is
// the single source of truth those callers need.

import { Pool } from 'pg';

export interface AgentCronState {
  agentId: string;
  nextFireMs: number;
  attempts: number;
  isAvailable: boolean;
  lockedAt: number | null;
  lastError: string | null;
}

// Re-use a single pool per-process so a burst of /api/agents requests
// doesn't open + close a connection every time. `Pool` is internally
// reference-counted; idle clients close themselves after `idleTimeoutMillis`.
let _pool: Pool | null = null;
function getPool(): Pool | null {
  if (_pool) return _pool;
  const connectionString = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!connectionString) return null;
  _pool = new Pool({ connectionString, max: 2, idleTimeoutMillis: 30_000 });
  return _pool;
}

/** Returns the next-fire row keyed by agent id for every agent that has
 *  a queued `agent-cron` row. Missing agents are simply absent from the
 *  returned Map (callers fall back to "no upcoming fire scheduled").
 *  Best-effort: returns an empty map on any DB error so the agents API
 *  doesn't 500 just because the cron pool DB query hiccupped. */
export async function loadAgentCronStates(): Promise<Map<string, AgentCronState>> {
  const pool = getPool();
  if (!pool) return new Map();
  try {
    const { rows } = await pool.query<{
      key: string;
      run_at: Date;
      attempts: number;
      is_available: boolean;
      locked_at: Date | null;
      last_error: string | null;
    }>(`
      SELECT j.key, j.run_at, j.attempts, j.is_available, j.locked_at, j.last_error
      FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier = 'agent-cron'
        AND j.key IS NOT NULL
    `);
    const map = new Map<string, AgentCronState>();
    for (const row of rows) {
      const agentId = row.key.replace(/^agent-cron-/, '');
      map.set(agentId, {
        agentId,
        nextFireMs: row.run_at.getTime(),
        attempts: row.attempts,
        isAvailable: row.is_available,
        lockedAt: row.locked_at ? row.locked_at.getTime() : null,
        lastError: row.last_error,
      });
    }
    return map;
  } catch (err) {
    console.warn('[agent-cron-state] load failed:', err instanceof Error ? err.message : err);
    return new Map();
  }
}

// Last skip reason telemetry. The cron task pushes one entry per fire;
// the agents API reads it to render "skipped 14m ago (jobs paused)" in
// the UI. In-memory + pinned on globalThis (cross-module-realm) so the
// cron task realm and the route realm share the same store.
declare global {
  var __tamtamAgentLastSkip: Map<string, { at: number; reason: string; status: 'skipped' | 'dispatched' | 'queued' }> | undefined;
  // Separate from __tamtamAgentLastSkip — tracks only real dispatches so the
  // orchestrator boost picker doesn't see 409-skipped agents as "just ran"
  // and starve them out of the staleness ranking.
  var __tamtamAgentLastDispatch: Map<string, number> | undefined;
}

function getStore(): Map<string, { at: number; reason: string; status: 'skipped' | 'dispatched' | 'queued' }> {
  if (!globalThis.__tamtamAgentLastSkip) {
    globalThis.__tamtamAgentLastSkip = new Map();
  }
  return globalThis.__tamtamAgentLastSkip;
}

function getDispatchStore(): Map<string, number> {
  if (!globalThis.__tamtamAgentLastDispatch) {
    globalThis.__tamtamAgentLastDispatch = new Map();
  }
  return globalThis.__tamtamAgentLastDispatch;
}

export function recordAgentAttempt(agentId: string, status: 'skipped' | 'dispatched' | 'queued', reason: string): void {
  const now = Date.now();
  getStore().set(agentId, { at: now, status, reason });
  if (status === 'dispatched') {
    getDispatchStore().set(agentId, now);
  }
}

export function getAgentLastAttempt(agentId: string): { at: number; reason: string; status: string } | null {
  return getStore().get(agentId) ?? null;
}

export function getAllAgentLastAttempts(): Map<string, { at: number; reason: string; status: string }> {
  return new Map(getStore());
}

export function getAllAgentLastDispatches(): Map<string, number> {
  return new Map(getDispatchStore());
}
