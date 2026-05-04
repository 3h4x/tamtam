// Internal node-based scheduler for tamtam scheduled agents.
//
// Why this exists:
//   PM2's `cron_restart` + `--no-autostart` combination silently fails to fire
//   the registered script (PM2 updates `pm_uptime` at the cron tick but never
//   actually starts the stopped process). We were registering ~36 agents in
//   PM2 that never ran. See docs/PIPELINE.md for the post-mortem.
//
// What this does:
//   Runs in-process inside the long-lived tamtam Next.js server. On boot,
//   loads every enabled scheduled agent from the DB and arms a setTimeout for
//   each. When the timer fires, it invokes the agent's `/api/agents/{id}/run`
//   endpoint via an in-process fetch and immediately schedules the next fire.
//   Agent CRUD routes call `upsertAgentSchedule` / `removeAgentSchedule` to
//   keep the in-memory schedule map in sync without restarting the server.
//
// Why not a 3rd-party cron lib:
//   The schedule grammar tamtam supports is just `Nh` / `Nm` intervals with a
//   stableHash phase offset (see lib/fire-times.ts). A few lines of date math
//   cover it without adding a dependency.

import { stableHash } from './fire-times';
import { normalizeAgentScheduleOrThrow } from './agent-schedule';
import { getIssueBranchLock } from '@/lib/shared/project-branch-lock';
import { getLock } from '@/lib/pipeline/pipeline-lock';
import { budgetBlockedResult, scheduledBurnRateBlocked } from '@/lib/shared/job-control';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';

type ScheduleEntry = {
  agentId: string;
  project: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  nextFireMs: number;
  lastFireMs: number | null;
  fireCount: number;
  errorCount: number;
  lastError: string | null;
  timer: NodeJS.Timeout | null;
  // Skipped fires when an issue branch was checked out and we declined to
  // run the agent on it. Tracked separately from errorCount so the
  // monitoring page can distinguish a paused-by-design state from real
  // failures.
  skippedCount: number;
  lastSkippedReason: string | null;
};

// Pin the scheduler state on globalThis so it survives Next.js's separation
// between the instrumentation runtime and route-handler runtimes (each gets
// its own module instance, but they share the Node process global). Without
// this, instrumentation arms the scheduler in one realm and the API route
// reads an empty Map from another realm.
type SchedulerGlobals = {
  __tamtamScheduler?: {
    entries: Map<string, ScheduleEntry>;
    started: boolean;
    paused: boolean;
    baseUrl: string;
  };
};

const g = globalThis as SchedulerGlobals;
const state = (g.__tamtamScheduler ??= {
  entries: new Map<string, ScheduleEntry>(),
  started: false,
  paused: false,
  baseUrl: `http://127.0.0.1:${process.env.PORT || '1337'}`,
});

const entries = state.entries;
function getStarted(): boolean { return state.started; }
function setStarted(v: boolean): void { state.started = v; }
function getPaused(): boolean { return state.paused; }
function setPaused(v: boolean): void { state.paused = v; }
function getBaseUrl(): string { return state.baseUrl; }
function setBaseUrl(v: string): void { state.baseUrl = v; }

export function setSchedulerBaseUrl(url: string): void {
  setBaseUrl(url.replace(/\/$/, ''));
}

/**
 * Compute the next time `schedule` should fire after `fromMs`.
 * Supported grammar: "Nh" (1h, 4h, 24h, …), "Nm" (15m, 30m, …), bare seconds.
 * Phase offset is derived from a stable hash of the agentId so different
 * agents with the same period don't all fire on the same minute.
 */
export function computeNextFire(schedule: string, agentId: string, fromMs: number = Date.now()): number {
  const s = normalizeAgentScheduleOrThrow(schedule);
  let periodMs = 0;
  let useHourGrid = false;

  if (s.endsWith('h')) {
    const hours = parseInt(s, 10);
    if (!hours || hours < 1) return fromMs + 3600_000;
    periodMs = hours * 3600_000;
    useHourGrid = hours <= 24;
  } else if (s.endsWith('m')) {
    const mins = parseInt(s, 10);
    if (!mins || mins < 1) return fromMs + 60_000;
    periodMs = mins * 60_000;
    useHourGrid = mins >= 60 && mins <= 24 * 60;
  } else {
    const secs = parseInt(s, 10) || 60;
    periodMs = secs * 1000;
  }

  if (useHourGrid && periodMs >= 3600_000) {
    // Hour-aligned schedule with stable per-agent phase: pick the next slot
    // matching `(startHour + k * cycleHours) : minOff` after `fromMs`.
    const cycleHours = Math.round(periodMs / 3600_000);
    const startHour = stableHash(agentId + ':h', cycleHours);
    const minOff = stableHash(agentId + ':min', 60);
    const now = new Date(fromMs);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    for (let h = startHour; h < 24 + startHour; h += cycleHours) {
      const candidate = today + h * 3600_000 + minOff * 60_000;
      if (candidate > fromMs) return candidate;
    }
    // Fall back to tomorrow's first slot
    return today + 86400_000 + startHour * 3600_000 + minOff * 60_000;
  }

  // Sub-hour or > 24h interval: fire on next period boundary from now.
  return fromMs + periodMs;
}

async function fire(entry: ScheduleEntry): Promise<void> {
  if (getPaused() || !entry.enabled) return;
  let shouldRearm = true;

  const budget = budgetBlockedResult('start scheduled agent');
  if (budget) {
    entry.skippedCount += 1;
    entry.lastSkippedReason = budget.detail;
    console.log(`[internal-scheduler] ${entry.project}/${entry.name} skipped — ${budget.detail}`);
    armNext(entry);
    shouldRearm = false;
    return;
  }

  // Burn-rate gate: skip scheduled fires when 7d projection is over quota.
  // Manual buttons stay free (this gate is only consulted here). Re-arm so the
  // scheduler keeps probing — once usage decays under the cap or the window
  // resets, scheduled work resumes automatically without user intervention.
  const burn = scheduledBurnRateBlocked();
  if (burn) {
    entry.skippedCount += 1;
    entry.lastSkippedReason = burn.reason;
    console.log(`[internal-scheduler] ${entry.project}/${entry.name} skipped — ${burn.reason}`);
    armNext(entry);
    shouldRearm = false;
    return;
  }

  // Don't fire while a release pipeline is running for the project. The
  // pipeline owns the working tree (commit/push are inline; review/fix run
  // back-to-back), and an agent firing in the middle would race with those
  // edits — agent edits get included in the in-flight commit, or trigger a
  // cascade of re-reviews on top of the pipeline's own changes.
  try {
    const lock = getLock(entry.project);
    if (lock) {
      const holderRow = db.select().from(schema.jobs).where(eq(schema.jobs.id, lock.lockedByJobId)).get();
      if (holderRow && holderRow.finishedAt === null) {
        entry.skippedCount += 1;
        entry.lastSkippedReason = `release pipeline active: ${holderRow.kind} ${holderRow.id}`;
        console.log(`[internal-scheduler] ${entry.project}/${entry.name} skipped — ${entry.lastSkippedReason}`);
        armNext(entry);
        shouldRearm = false;
        return;
      }
    }
  } catch {
    // Lock probe failure shouldn't block runs — fall through.
  }

  // Don't fire scheduled agents while an issue branch is checked out for the
  // project — they'd run with cwd on someone's WIP feature branch and either
  // edit unrelated files there or get pushed in surprise commits. The user's
  // manual Run buttons on /project/[name] are already disabled in this state;
  // the scheduler is the leaky path. Re-arm so the next tick re-checks.
  try {
    const lockedBranch = await getIssueBranchLock(entry.project);
    if (lockedBranch) {
      entry.skippedCount += 1;
      entry.lastSkippedReason = `issue branch active: ${lockedBranch}`;
      console.log(`[internal-scheduler] ${entry.project}/${entry.name} skipped — ${entry.lastSkippedReason}`);
      armNext(entry);
      shouldRearm = false;
      return;
    }
  } catch {
    // Detection failure shouldn't block runs — fall through and fire normally.
  }

  entry.lastFireMs = Date.now();
  entry.fireCount += 1;
  const url = `${getBaseUrl()}/api/agents/${entry.agentId}/run`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tamtam-Trigger': 'schedule' },
      body: JSON.stringify({ prompt: entry.prompt }),
    });
    if (!res.ok) {
      if (res.status === 429) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json() as { detail?: string };
          if (body.detail) detail = body.detail;
        } catch {}
        entry.skippedCount += 1;
        entry.lastSkippedReason = detail;
        console.log(`[internal-scheduler] ${entry.project}/${entry.name} skipped — ${detail}`);
        return;
      }
      if (res.status === 409) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json() as { detail?: string };
          if (body.detail) detail = body.detail;
        } catch {}
        if (detail.includes('already running')) {
          entry.skippedCount += 1;
          entry.lastSkippedReason = detail;
          console.log(`[internal-scheduler] ${entry.project}/${entry.name} skipped — ${detail}`);
          return;
        }
        if (detail.includes('Jobs are paused globally')) {
          entry.errorCount += 1;
          entry.lastError = detail;
          console.warn(`[internal-scheduler] pausing after route rejected scheduled fire: ${detail}`);
          pauseInternalScheduler();
          return;
        }
        if (detail.includes('is disabled') || detail.includes('has no schedule')) {
          console.warn(`[internal-scheduler] removing stale schedule for ${entry.project}/${entry.name} — ${detail}`);
          removeAgentSchedule(entry.agentId);
          shouldRearm = false;
          return;
        }
        if (detail.includes('issue branch')) {
          entry.skippedCount += 1;
          entry.lastSkippedReason = detail;
          console.log(`[internal-scheduler] ${entry.project}/${entry.name} skipped — ${detail}`);
          return;
        }
        entry.errorCount += 1;
        entry.lastError = detail;
        console.error(`[internal-scheduler] ${entry.project}/${entry.name} conflict: ${detail}`);
        return;
      }
      if (res.status === 404) {
        entry.errorCount += 1;
        entry.lastError = `HTTP ${res.status}`;
        console.warn(`[internal-scheduler] ${entry.project}/${entry.name} removed — ${entry.lastError}`);
        removeAgentSchedule(entry.agentId);
        shouldRearm = false;
        return;
      }
      entry.errorCount += 1;
      entry.lastError = `HTTP ${res.status}`;
      console.error(`[internal-scheduler] ${entry.project}/${entry.name} fire failed: ${entry.lastError}`);
    } else {
      entry.lastError = null;
      console.log(`[internal-scheduler] ${entry.project}/${entry.name} fired`);
    }
  } catch (err) {
    entry.errorCount += 1;
    entry.lastError = err instanceof Error ? err.message : String(err);
    console.error(`[internal-scheduler] ${entry.project}/${entry.name} fire threw:`, entry.lastError);
  } finally {
    // Always re-arm — a failed fire shouldn't disable the schedule.
    if (shouldRearm) armNext(entry);
  }
}

function armNext(entry: ScheduleEntry): void {
  if (!entry.enabled) return;
  if (getPaused()) return;
  if (!entries.has(entry.agentId)) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.nextFireMs = computeNextFire(entry.schedule, entry.agentId);
  const delay = Math.max(1000, entry.nextFireMs - Date.now());
  entry.timer = setTimeout(() => { void fire(entry); }, delay);
  // Ensure timers don't keep the process alive on its own — let the server
  // decide when to exit. This matters for tests and for `pnpm stop`.
  entry.timer.unref?.();
}

export type AgentInput = {
  id: string;
  project: string;
  name: string;
  schedule: string | null;
  prompt: string | null;
  enabled: boolean;
};

export function upsertAgentSchedule(agent: AgentInput): void {
  removeAgentSchedule(agent.id);
  if (!agent.enabled || !agent.schedule) return;
  const normalizedSchedule = normalizeAgentScheduleOrThrow(agent.schedule);
  const entry: ScheduleEntry = {
    agentId: agent.id,
    project: agent.project,
    name: agent.name,
    schedule: normalizedSchedule,
    prompt: agent.prompt ?? '',
    enabled: true,
    nextFireMs: 0,
    lastFireMs: null,
    fireCount: 0,
    errorCount: 0,
    lastError: null,
    timer: null,
    skippedCount: 0,
    lastSkippedReason: null,
  };
  entries.set(agent.id, entry);
  armNext(entry);
}

export function removeAgentSchedule(agentId: string): void {
  const existing = entries.get(agentId);
  if (!existing) return;
  if (existing.timer) clearTimeout(existing.timer);
  entries.delete(agentId);
}

export function startInternalScheduler(agents: AgentInput[]): void {
  // Idempotent — safe to call multiple times (e.g. after HMR).
  for (const e of entries.values()) {
    if (e.timer) clearTimeout(e.timer);
  }
  entries.clear();
  for (const a of agents) {
    try {
      upsertAgentSchedule(a);
    } catch (err) {
      console.warn(
        `[internal-scheduler] skipping ${a.project}/${a.name} — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  setStarted(true);
  console.log(`[internal-scheduler] armed ${entries.size} schedule(s)`);
}

export function pauseInternalScheduler(): void {
  setPaused(true);
  for (const e of entries.values()) {
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
  }
  console.log('[internal-scheduler] paused');
}

export function resumeInternalScheduler(): void {
  if (!getPaused()) return;
  setPaused(false);
  for (const e of entries.values()) {
    armNext(e);
  }
  console.log(`[internal-scheduler] resumed ${entries.size} schedule(s)`);
}

export function stopInternalScheduler(): void {
  for (const e of entries.values()) {
    if (e.timer) clearTimeout(e.timer);
  }
  entries.clear();
  setStarted(false);
  setPaused(false);
}

export type SchedulerEntryDump = {
  agentId: string;
  project: string;
  name: string;
  schedule: string;
  enabled: boolean;
  nextFireMs: number;
  lastFireMs: number | null;
  fireCount: number;
  errorCount: number;
  lastError: string | null;
  skippedCount: number;
  lastSkippedReason: string | null;
};

export function dumpInternalScheduler(): { started: boolean; paused: boolean; entries: SchedulerEntryDump[] } {
  const out: SchedulerEntryDump[] = [];
  for (const e of entries.values()) {
    out.push({
      agentId: e.agentId,
      project: e.project,
      name: e.name,
      schedule: e.schedule,
      enabled: e.enabled,
      nextFireMs: e.nextFireMs,
      lastFireMs: e.lastFireMs,
      fireCount: e.fireCount,
      errorCount: e.errorCount,
      lastError: e.lastError,
      skippedCount: e.skippedCount,
      lastSkippedReason: e.lastSkippedReason,
    });
  }
  out.sort((a, b) => a.nextFireMs - b.nextFireMs);
  return { started: getStarted(), paused: getPaused(), entries: out };
}
