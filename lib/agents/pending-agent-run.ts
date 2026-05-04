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
  if (q.length === 0) queues.delete(project);
  return next;
}

export function listQueuedAgents(project: string): QueueEntry[] {
  return [...(queues.get(project) ?? [])];
}

export function clearProjectQueue(project: string): void {
  queues.delete(project);
}

export function clearAllQueues(): void {
  queues.clear();
}

// Drain the next queued agent for a project by calling its run endpoint via
// internal fetch. Mirrors how the internal scheduler triggers fires, so the
// route handler stays the single source of truth for prompt composition,
// skill loading, gate checks, etc.
export async function drainNextAgentRun(project: string): Promise<void> {
  const next = dequeueNextAgentRun(project);
  if (!next) return;
  const port = process.env.PORT || '1337';
  const baseUrl = process.env.TAMTAM_BASE_URL || `http://localhost:${port}`;
  const url = `${baseUrl}/api/agents/${encodeURIComponent(next.agentId)}/run`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tamtam-trigger': next.triggeredBy,
      },
      body: JSON.stringify({ prompt: next.prompt }),
    });
    if (!r.ok && r.status !== 202) {
      const body = await r.text().catch(() => '');
      console.warn(
        `[pending-agent-run] drain ${next.agentName} for ${project} failed: ${r.status} ${body.slice(0, 200)}`,
      );
    } else {
      console.log(`[pending-agent-run] drained ${next.agentName} for ${project} (${r.status})`);
    }
  } catch (e) {
    console.error(`[pending-agent-run] drain error for ${project}/${next.agentName}:`, e);
  }
}
