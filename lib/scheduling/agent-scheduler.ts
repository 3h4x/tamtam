// Public scheduler API used by `/api/agents` routes and the recommendations
// applier. Backed by graphile-worker since the in-memory scheduler was
// retired (see `lib/workflows/cron/seed-agent-crons.ts` + `agent-cron-task.ts`
// for the actual cron-tick handler).
//
// The same prompt-file persistence pattern from the in-memory era is kept
// here: each agent's prompt is written to `<logDir>/agent-scripts/<agentId>.prompt.json`
// so out-of-band reruns can recover it after a server restart.

import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { quickAddJob } from 'graphile-worker';
import { Pool } from 'pg';
import { getImproveConfig } from './scheduling';
import { normalizeAgentScheduleOrThrow } from './agent-schedule';
import { computeNextFire } from '@/lib/workflows/cron/parse-schedule';

function getLogDir(): string {
  try { return getImproveConfig().logDir; } catch { return join(/*turbopackIgnore: true*/ homedir(), 'logs'); }
}
function getScriptsDir(): string {
  return join(getLogDir(), 'agent-scripts');
}

function agentPromptPath(agentId: string): string {
  return join(/*turbopackIgnore: true*/ getScriptsDir(), `${agentId}.prompt.json`);
}

function cleanupFiles(agentId: string): void {
  try {
    const p = agentPromptPath(agentId);
    if (existsSync(/*turbopackIgnore: true*/ p)) unlinkSync(/*turbopackIgnore: true*/ p);
  } catch {
    /* best-effort */
  }
}

function ensureDirs(): void {
  mkdirSync(/*turbopackIgnore: true*/ getScriptsDir(), { recursive: true });
}

function jobKey(agentId: string): string {
  return `agent-cron-${agentId}`;
}

function resolveConnectionString(): string | null {
  return process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL ?? null;
}

// --- Public API ---

export async function installAgentSchedule(
  agentId: string,
  schedule: string,
  prompt: string,
  project?: string,
  agentName?: string,
): Promise<void> {
  const normalizedSchedule = normalizeAgentScheduleOrThrow(schedule);
  ensureDirs();
  writeFileSync(/*turbopackIgnore: true*/ agentPromptPath(agentId), JSON.stringify({ prompt }));

  const connectionString = resolveConnectionString();
  if (!connectionString) {
    throw new Error('cannot install agent schedule: no postgres URL (WORKFLOW_POSTGRES_URL or DATABASE_URL)');
  }
  const runAt = new Date(computeNextFire(normalizedSchedule, agentId, Date.now()));
  await quickAddJob(
    { connectionString },
    'agent-cron',
    { agentId },
    {
      jobKey: jobKey(agentId),
      jobKeyMode: 'replace',
      runAt,
      maxAttempts: 5,
    },
  );
  // project + agentName are accepted for API compatibility; the cron task
  // handler resolves them on each fire via listEnabledScheduledAgents().
  void project;
  void agentName;
}

export async function uninstallAgentSchedule(
  agentId: string,
  _project?: string,
  _agentName?: string,
): Promise<void> {
  const connectionString = resolveConnectionString();
  if (connectionString) {
    // Mark the next fire as one year out — the cron task handler will then
    // load the agent fresh, see it's disabled (the caller already cleared
    // `enabled` in the DB), and naturally terminate the chain without
    // re-enqueuing. This is graphile-worker's idiomatic "cancel" since
    // there's no removeJob primitive in the public API.
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    try {
      await quickAddJob(
        { connectionString },
        'agent-cron',
        { agentId },
        { jobKey: jobKey(agentId), jobKeyMode: 'replace', runAt: farFuture, maxAttempts: 5 },
      );
    } catch (err) {
      console.warn(`[agent-scheduler] uninstall ${agentId} addJob failed:`, err);
    }
  }
  cleanupFiles(agentId);
}

export async function isAgentScheduleLoaded(
  agentId: string,
  _project?: string,
  _agentName?: string,
): Promise<boolean> {
  const connectionString = resolveConnectionString();
  if (!connectionString) return false;
  // Cheap check: prompt file exists. The actual queue state lives in
  // graphile_worker.jobs but reading that is a heavier query; the prompt
  // file is the canonical client-visible "agent installed?" marker.
  return existsSync(/*turbopackIgnore: true*/ agentPromptPath(agentId));
}

// --- Health / verification ---

export type SchedulerExpected = {
  id: string;
  project: string;
  name: string;
  schedule: string;
  expectedName: string;
  queueKey: string;
  promptFileLoaded?: boolean;
  queueLoaded?: boolean;
};

export type SchedulerHealth = {
  ok: boolean;
  expected: SchedulerExpected[];
  actual: { graphile: string[] };
  missing: SchedulerExpected[];
  orphans: { graphile: string[] };
  errors: string[];
};

async function loadAgentCronQueueKeys(keys: string[], connectionString: string): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const { rows } = await pool.query<{ key: string }>(
      `
        SELECT key
        FROM graphile_worker._private_jobs
        WHERE key = ANY($1::text[])
          AND task_id = (
            SELECT id
            FROM graphile_worker._private_tasks
            WHERE identifier = 'agent-cron'
            LIMIT 1
          )
      `,
      [keys],
    );
    return new Set(rows.map((row) => row.key));
  } finally {
    await pool.end();
  }
}

export async function getSchedulerHealth(
  agents: Array<{ id: string; project: string; name: string; schedule: string | null; enabled: boolean }>,
): Promise<SchedulerHealth> {
  const expected: SchedulerExpected[] = [];
  for (const a of agents) {
    if (!a.enabled || !a.schedule) continue;
    expected.push({
      id: a.id,
      project: a.project,
      name: a.name,
      schedule: a.schedule,
      // expectedName retained for response-shape compatibility; uses the
      // legacy `tamtam-<project>-agent-<name>` format readers may expect.
      expectedName: a.project && a.name ? `tamtam-${a.project}-agent-${a.name}` : `tamtam-agent-${a.id}`,
      queueKey: jobKey(a.id),
    });
  }

  const errors: string[] = [];
  let queuedKeys = new Set<string>();
  const connectionString = resolveConnectionString();
  if (!connectionString && expected.length > 0) {
    errors.push('no postgres URL configured for graphile-worker scheduler');
  } else if (connectionString) {
    try {
      queuedKeys = await loadAgentCronQueueKeys(expected.map((e) => e.queueKey), connectionString);
    } catch (err) {
      errors.push(`graphile queue check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const missing: SchedulerExpected[] = [];
  for (const e of expected) {
    const promptFileLoaded = existsSync(/*turbopackIgnore: true*/ agentPromptPath(e.id));
    const queueLoaded = queuedKeys.has(e.queueKey);
    if (!promptFileLoaded || !queueLoaded) {
      missing.push({ ...e, promptFileLoaded, queueLoaded });
    }
  }

  const ok = errors.length === 0 && missing.length === 0;
  return {
    ok,
    expected,
    actual: { graphile: [...queuedKeys].sort() },
    missing,
    orphans: { graphile: [] },
    errors,
  };
}

/** Legacy export kept for the monitoring panel; returns an empty dump now
 *  that the in-memory scheduler is gone. The /monitoring page can switch
 *  to the graphile-worker queue API in a follow-up. */
export interface SchedulerEntryDump {
  agentId: string;
  project: string;
  name: string;
  schedule: string;
  nextFireMs: number;
  fireCount: number;
  lastFireMs: number | null;
  lastJobMs?: number | null;
  skippedCount: number;
  lastSkippedReason: string | null;
  lastError: string | null;
  enabled: boolean;
}

export interface InternalSchedulerDump {
  started: boolean;
  paused: boolean;
  entries: SchedulerEntryDump[];
}

export async function getInternalSchedulerDump(): Promise<InternalSchedulerDump> {
  return { started: false, paused: false, entries: [] };
}
