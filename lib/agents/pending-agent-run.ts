// Pending-agent-run queue. Only one agent should run at a time per project —
// concurrent agents racing on the same git worktree clobber each other's
// commits and branch state. When an agent run is requested while another
// agent is already running, the request is queued here instead of starting
// concurrently. The queue is drained when any agent run finishes for the
// project (lifecycle hook calls drainNextAgentRun).
//
// In-memory only. On server restart the queue is dropped — that's fine
// because the internal scheduler re-fires scheduled agents on the next
// tick, and manually-queued runs are a transient signal anyway.

import type { JobData } from '@/lib/jobs/types';

export type QueueEntry = {
  agentId: string;
  agentName: string;
  triggeredBy: string;
  prompt: string;
  enqueuedAt: number;
  modelOverride?: 'fast' | 'normal' | 'smart';
};

const queues = new Map<string, QueueEntry[]>();
const retryTimers = new Map<string, NodeJS.Timeout>();
const TEMPORARY_DRAIN_RETRY_MS = 30_000;

// Circuit breaker: drains that fail fast (e.g. PM2 spawn EBADF after FD
// exhaustion) used to be re-fired by the lifecycle-hook drain at ~50/sec,
// because nothing tracked that the same head had just failed. We now keep a
// per-project attempt record so a hot loop of identical failures backs off
// and eventually drops the head instead of producing thousands of dead jobs.
const MAX_CONSECUTIVE_FAILURES = 5;
const inFlight = new Set<string>();
type AttemptRecord = { agentId: string; enqueuedAt: number; consecutiveFailures: number };
const attempts = new Map<string, AttemptRecord>();

function sameQueueEntry(a: Pick<QueueEntry, 'agentId' | 'enqueuedAt'> | null | undefined, b: Pick<QueueEntry, 'agentId' | 'enqueuedAt'> | null | undefined): boolean {
  return !!a && !!b && a.agentId === b.agentId && a.enqueuedAt === b.enqueuedAt;
}

function noteFailure(project: string, entry: Pick<QueueEntry, 'agentId' | 'enqueuedAt'>): number {
  const cur = attempts.get(project);
  const failures = cur && sameQueueEntry(cur, entry) ? cur.consecutiveFailures + 1 : 1;
  attempts.set(project, { ...entry, consecutiveFailures: failures });
  return failures;
}

function clearAttempts(project: string): void {
  attempts.delete(project);
}

function clearAttemptsForEntry(project: string, entry: Pick<QueueEntry, 'agentId' | 'enqueuedAt'>): void {
  const cur = attempts.get(project);
  if (sameQueueEntry(cur, entry)) {
    attempts.delete(project);
  }
}

// Synchronous per-project lock held while an agent run is being constructed
// (after the listJobs() running-agent check, until createJob() lands the new
// row in jobsCache). Without this, two concurrent POSTs both observe an
// empty running-agent list at the top of the route, both pass the check, and
// both proceed through the awaits to createJob — bypassing the per-project
// serialization the listJobs check is meant to enforce. Map value is the
// agentName so a same-agent race can return 409 instead of double-queueing.
type StartingAgent = {
  agentName: string;
  startedAt: number;
};

declare global {
  var __tamtamStartingAgents: Map<string, StartingAgent> | undefined;
}

const startingAgents = globalThis.__tamtamStartingAgents ?? new Map<string, StartingAgent>();
globalThis.__tamtamStartingAgents = startingAgents;

// A claim is held only for the duration of a single agent-start route call
// (dirty-worktree + branch-freshness checks, which may run a git fetch, then
// the detached spawn). That window is seconds in the normal case; a generous
// upper bound covers a slow fetch. Anything older than this is a *leaked*
// claim — the holding route threw without reaching its `finally`, or an await
// inside it hung after the underlying agent process was killed (e.g. SIGKILL).
// Without eviction a leaked claim deadlocks the project forever: the synthetic
// `<project>-agent-starting` job blocks both pending-release drains and every
// queued agent run. Evicting on read/claim lets the deadlock self-heal on the
// next drain cycle instead of waiting for a server restart.
const START_SLOT_TTL_S = 5 * 60;

function evictIfStale(project: string): void {
  const existing = startingAgents.get(project);
  if (existing && Date.now() / 1000 - existing.startedAt > START_SLOT_TTL_S) {
    console.warn(
      `[pending-agent-run] evicting stale start slot for ${project} ` +
        `(agent '${existing.agentName}', age ${Math.round(Date.now() / 1000 - existing.startedAt)}s)`,
    );
    startingAgents.delete(project);
  }
}

export function tryClaimAgentStartSlot(project: string, agentName: string):
  | { ok: true }
  | { ok: false; runningAgent: string } {
  evictIfStale(project);
  const existing = startingAgents.get(project);
  if (existing) return { ok: false, runningAgent: existing.agentName };
  startingAgents.set(project, { agentName, startedAt: Date.now() / 1000 });
  return { ok: true };
}

export function releaseAgentStartSlot(project: string): void {
  startingAgents.delete(project);
}

export function hasAgentStartSlot(project: string): boolean {
  evictIfStale(project);
  return startingAgents.has(project);
}

export function getAgentStartSlotJob(project: string): JobData | null {
  evictIfStale(project);
  const slot = startingAgents.get(project);
  if (!slot) return null;
  return {
    id: `${project}-agent-starting`,
    project,
    kind: `agent:${slot.agentName}`,
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: slot.startedAt,
    finishedAt: null,
    exitCode: null,
    seen: false,
    contextMeta: null,
    userPrompt: null,
    parentJobId: null,
    ghIssueNumber: null,
    ghIssueRepo: null,
    ghIssueTitle: null,
    releaseId: null,
    abortedAt: null,
  };
}

// Idempotent per (project, agentId) — re-enqueueing the same agent while it
// already has a pending entry replaces the prompt (latest wins) but does not
// duplicate the slot. Keeps the queue length bounded under repeated fires.
export function enqueueAgentRun(project: string, entry: QueueEntry): void {
  let q = queues.get(project);
  if (!q) {
    q = [];
    queues.set(project, q);
  }
  const existing = q.findIndex((e) => e.agentId === entry.agentId);
  if (existing >= 0) {
    clearAttemptsForEntry(project, q[existing]);
    q[existing] = entry;
    return;
  }
  q.push(entry);
}

export function dequeueNextAgentRun(project: string): QueueEntry | null {
  const q = queues.get(project);
  if (!q || q.length === 0) return null;
  const next = q.shift() ?? null;
  if (q.length === 0) {
    queues.delete(project);
    clearDrainRetry(project);
    clearAttempts(project);
  }
  return next;
}

export function listQueuedAgents(project: string): QueueEntry[] {
  return [...(queues.get(project) ?? [])];
}

export function listQueuedProjects(): string[] {
  return [...queues.keys()];
}

export function clearProjectQueue(project: string): void {
  queues.delete(project);
  clearDrainRetry(project);
  clearAttempts(project);
}

export function clearAllQueues(): void {
  queues.clear();
  startingAgents.clear();
  for (const timer of retryTimers.values()) {
    clearTimeout(timer);
  }
  retryTimers.clear();
  attempts.clear();
  inFlight.clear();
}

function clearDrainRetry(project: string): void {
  const timer = retryTimers.get(project);
  if (timer) clearTimeout(timer);
  retryTimers.delete(project);
}

function scheduleDrainRetry(project: string, delayMs = TEMPORARY_DRAIN_RETRY_MS): void {
  if (!queues.has(project) || retryTimers.has(project)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(project);
    void drainNextAgentRun(project);
  }, delayMs);
  timer.unref?.();
  retryTimers.set(project, timer);
}

// Drain the next queued agent for a project by calling its run endpoint via
// internal fetch. Mirrors how the internal scheduler triggers fires, so the
// route handler stays the single source of truth for prompt composition,
// skill loading, gate checks, etc.
export async function drainNextAgentRun(project: string): Promise<void> {
  // Circuit breaker against re-entrant drains. The lifecycle hook fires
  // drainNextAgentRun() on every agent finish, including the one this drain
  // just spawned via fetch. Without this guard, a route that fails fast
  // (e.g. PM2 spawn EBADF) calls markDone → completion hooks → drain →
  // POST → markDone → … producing ~50 dead jobs/sec on the same queue head.
  // Serializing per project lets the in-flight POST finish (and dropHead on
  // success or scheduleDrainRetry on 5xx) before any other caller proceeds.
  if (inFlight.has(project)) return;

  // A route still holds the synchronous "starting" critical section for this
  // project. Leave the queue intact and let that route drain after release so
  // we never drop a head entry on a transient 409 "already starting" reply.
  if (hasAgentStartSlot(project)) return;

  const q = queues.get(project);
  const next = q?.[0] ?? null;
  if (!next) return;
  const port = process.env.PORT || '1337';
  const baseUrl = process.env.TAMTAM_BASE_URL || `http://localhost:${port}`;
  const url = `${baseUrl}/api/agents/${encodeURIComponent(next.agentId)}/run`;
  const dropHead = () => {
    const head = queues.get(project)?.[0];
    if (sameQueueEntry(head, next)) {
      dequeueNextAgentRun(project);
    }
  };
  const tripBreakerIfExhausted = (failures: number, reason: string): boolean => {
    if (failures < MAX_CONSECUTIVE_FAILURES) return false;
    console.warn(
      `[pending-agent-run] circuit breaker tripped for ${next.agentName}/${project} after ${failures} consecutive failures (${reason}) — dropping head`,
    );
    dropHead();
    clearAttempts(project);
    return true;
  };
  inFlight.add(project);
  try {
    const body: { prompt: string; model?: 'fast' | 'normal' | 'smart' } = { prompt: next.prompt };
    if (next.modelOverride) body.model = next.modelOverride;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tamtam-trigger': next.triggeredBy,
      },
      body: JSON.stringify(body),
    });
    if (r.status === 202) {
      const body = await r.text().catch(() => '');
      let parsed: { code?: string } | null = null;
      try { parsed = body ? JSON.parse(body) as { code?: string } : null; } catch {}
      if (parsed?.code === 'pipeline_lock' || parsed?.code === 'pending_release') {
        // The DB queue now owns this run (survives restart). Drop the in-memory
        // head so we don't double-fire when release recovery replays it.
        dropHead();
        clearAttempts(project);
        console.log(
          `[pending-agent-run] handed ${next.agentName} to DB queue (${parsed.code}) for ${project}`,
        );
        return;
      }
      // Another agent is running or starting — keep the in-memory head so it
      // retries once the blocker clears (lifecycle drain).
      console.log(
        `[pending-agent-run] keeping ${next.agentName} queued for ${project}: ${r.status} ${body.slice(0, 200)}`,
      );
      return;
    }

    if (r.ok) {
      dropHead();
      clearAttempts(project);
      console.log(`[pending-agent-run] drained ${next.agentName} for ${project} (${r.status})`);
      return;
    }

    if (r.status === 409) {
      const raw = await r.text().catch(() => '');
      let parsed: { code?: string; detail?: string } | null = null;
      try { parsed = raw ? JSON.parse(raw) as { code?: string; detail?: string } : null; } catch {}
      const code = parsed?.code ?? '';
      // Transient: same-project serialization blockers — keep the head so it
      // retries once the running/starting agent finishes. Global pause is also
      // transient, but resume needs to trigger a fresh drain.
      const transient =
        code === 'already_running' ||
        code === 'already_starting' ||
        code === 'project_busy' ||
        code === 'project_paused' ||
        code === 'jobs_paused' ||
        (parsed?.detail ?? raw).includes('Jobs are paused globally') ||
        (parsed?.detail ?? raw).includes('project paused');
      if (transient) {
        console.log(
          `[pending-agent-run] keeping ${next.agentName} queued for ${project}: ${r.status} ${code} ${(parsed?.detail ?? raw).slice(0, 200)}`,
        );
        return;
      }
      // Terminal: the agent itself can't run right now (disabled, no schedule,
      // issue branch, or unknown 409). Drop the head so later queued entries
      // don't starve. The scheduler will re-fire eligible agents on its own
      // tick if/when conditions clear.
      dropHead();
      clearAttempts(project);
      console.warn(
        `[pending-agent-run] dropping ${next.agentName} from queue for ${project}: ${r.status} ${code || 'unknown_409'} ${(parsed?.detail ?? raw).slice(0, 200)}`,
      );
      return;
    }

    if (r.status === 429) {
      const raw = await r.text().catch(() => '');
      let parsed: { code?: string; detail?: string } | null = null;
      try { parsed = raw ? JSON.parse(raw) as { code?: string; detail?: string } : null; } catch {}
      scheduleDrainRetry(project);
      console.log(
        `[pending-agent-run] keeping ${next.agentName} queued for ${project}: ${r.status} ${(parsed?.detail ?? raw).slice(0, 200)}`,
      );
      return;
    }

    if (r.status === 400 || r.status === 404) {
      const body = await r.text().catch(() => '');
      dropHead();
      clearAttempts(project);
      console.warn(
        `[pending-agent-run] dropping ${next.agentName} from queue for ${project}: ${r.status} ${body.slice(0, 200)}`,
      );
      return;
    }

    if (!r.ok) {
      // 5xx (and any other unhandled non-success): count the failure, trip
      // the breaker after the cap, and back off via the retry timer otherwise.
      const body = await r.text().catch(() => '');
      const failures = noteFailure(project, next);
      if (tripBreakerIfExhausted(failures, `HTTP ${r.status}`)) return;
      scheduleDrainRetry(project);
      console.warn(
        `[pending-agent-run] drain ${next.agentName} for ${project} failed: ${r.status} ${body.slice(0, 200)} (attempt ${failures}/${MAX_CONSECUTIVE_FAILURES})`,
      );
    }
  } catch (e) {
    // Network-level failure (route unreachable, abort, fetch crash). Treat
    // identically to 5xx: count, retry, trip after the cap.
    const failures = noteFailure(project, next);
    if (!tripBreakerIfExhausted(failures, 'fetch error')) {
      scheduleDrainRetry(project);
    }
    console.error(`[pending-agent-run] drain error for ${project}/${next.agentName} (attempt ${failures}/${MAX_CONSECUTIVE_FAILURES}):`, e);
  } finally {
    inFlight.delete(project);
  }
}
