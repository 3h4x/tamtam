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

export type QueueEntry = {
  agentId: string;
  agentName: string;
  triggeredBy: string;
  prompt: string;
  enqueuedAt: number;
};

const queues = new Map<string, QueueEntry[]>();
const retryTimers = new Map<string, NodeJS.Timeout>();
const TEMPORARY_DRAIN_RETRY_MS = 30_000;

// Synchronous per-project lock held while an agent run is being constructed
// (after the listJobs() running-agent check, until createJob() lands the new
// row in jobsCache). Without this, two concurrent POSTs both observe an
// empty running-agent list at the top of the route, both pass the check, and
// both proceed through the awaits to createJob — bypassing the per-project
// serialization the listJobs check is meant to enforce. Map value is the
// agentName so a same-agent race can return 409 instead of double-queueing.
const startingAgents = new Map<string, string>();

export function tryClaimAgentStartSlot(project: string, agentName: string):
  | { ok: true }
  | { ok: false; runningAgent: string } {
  const existing = startingAgents.get(project);
  if (existing) return { ok: false, runningAgent: existing };
  startingAgents.set(project, agentName);
  return { ok: true };
}

export function releaseAgentStartSlot(project: string): void {
  startingAgents.delete(project);
}

export function hasAgentStartSlot(project: string): boolean {
  return startingAgents.has(project);
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
}

export function clearAllQueues(): void {
  queues.clear();
  startingAgents.clear();
  for (const timer of retryTimers.values()) {
    clearTimeout(timer);
  }
  retryTimers.clear();
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
    if (head?.agentId === next.agentId) {
      dequeueNextAgentRun(project);
    }
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tamtam-trigger': next.triggeredBy,
      },
      body: JSON.stringify({ prompt: next.prompt }),
    });
    if (r.status === 202) {
      // The route only returns 202 when it re-queues this fire because another
      // agent on the project is still running or starting. Leave the local
      // head entry intact so it can be retried after the blocker clears.
      const body = await r.text().catch(() => '');
      console.log(
        `[pending-agent-run] keeping ${next.agentName} queued for ${project}: ${r.status} ${body.slice(0, 200)}`,
      );
      return;
    }

    if (r.ok) {
      dropHead();
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
        code === 'jobs_paused' ||
        (parsed?.detail ?? raw).includes('Jobs are paused globally');
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
      console.warn(
        `[pending-agent-run] dropping ${next.agentName} from queue for ${project}: ${r.status} ${body.slice(0, 200)}`,
      );
      return;
    }

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.warn(
        `[pending-agent-run] drain ${next.agentName} for ${project} failed: ${r.status} ${body.slice(0, 200)}`,
      );
    }
  } catch (e) {
    console.error(`[pending-agent-run] drain error for ${project}/${next.agentName}:`, e);
  }
}
