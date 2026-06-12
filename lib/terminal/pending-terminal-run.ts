// DB-backed queue for terminal `run` requests that arrived while a blocking
// job (release, fix, fix-ci, push, another run, or agent) was running for the
// project. Instead of rejecting the user's typed prompt with a 409, the run
// route persists the raw request here and drains it FIFO once the blocker
// clears — ahead of any queued agent (user input has priority).
//
// Persisted in `queued_terminal_runs` so a queued run survives a TamTam
// restart; boot recovery replays the head. The drain re-POSTs the stored
// payload to the run route (mirroring `drainNextAgentRun`'s internal-fetch
// pattern) so the route stays the single source of prompt composition.

import { db, schema } from '@/lib/db';
import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

// Raw run inputs captured at the route's blocking-check point, before prompt
// composition (personas, base prompt, attachment append). Replaying these
// through the route recomposes the prompt identically to an immediate run.
export interface TerminalRunPayload {
  prompt: string;
  userPrompt?: string;
  model?: string;
  provider?: string;
  permissionMode?: string;
  resumeSessionId?: string;
  personas?: string[];
  contextMeta?: string;
  ghIssueNumber?: number | null;
  ghIssueRepo?: string;
  ghIssueTitle?: string;
  attachmentPaths?: string[];
}

export interface QueuedTerminalRun {
  id: string;
  project: string;
  enqueuedAt: number;
  payload: TerminalRunPayload;
  status: 'pending' | 'started';
  startedJobId: string | null;
}

// Header set on a drain replay so the run route starts the job (rather than
// re-enqueuing it) and, if the project is still blocked, returns 409 without
// creating a duplicate queue row.
export const TERMINAL_DRAIN_HEADER = 'x-tamtam-terminal-drain';

// Serialize per-project so two finish-seam drains don't both re-POST the same
// head. In-memory is fine — a restart drops the lock and boot recovery resumes.
const inFlight = new Set<string>();

function parsePayload(raw: string): TerminalRunPayload {
  try {
    return JSON.parse(raw) as TerminalRunPayload;
  } catch {
    return { prompt: '' };
  }
}

export async function enqueueTerminalRun(
  project: string,
  payload: TerminalRunPayload,
): Promise<{ queueId: string; position: number }> {
  const queueId = randomUUID();
  const enqueuedAt = Date.now() / 1000;
  await db.insert(schema.queuedTerminalRuns).values({
    id: queueId,
    project,
    enqueuedAt,
    payload: JSON.stringify(payload),
    status: 'pending',
    startedJobId: null,
  }).execute();
  const pending = await listQueuedTerminalRuns(project);
  const position = Math.max(1, pending.findIndex((e) => e.id === queueId) + 1);
  return { queueId, position };
}

export async function listQueuedTerminalRuns(project: string): Promise<QueuedTerminalRun[]> {
  const rows = await db
    .select()
    .from(schema.queuedTerminalRuns)
    .where(and(
      eq(schema.queuedTerminalRuns.project, project),
      eq(schema.queuedTerminalRuns.status, 'pending'),
    ))
    .orderBy(asc(schema.queuedTerminalRuns.enqueuedAt));
  return rows.map(rowToEntry);
}

export async function hasPendingTerminalRun(project: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.queuedTerminalRuns.id })
    .from(schema.queuedTerminalRuns)
    .where(and(
      eq(schema.queuedTerminalRuns.project, project),
      eq(schema.queuedTerminalRuns.status, 'pending'),
    ))
    .limit(1);
  return rows.length > 0;
}

export async function getQueuedTerminalRun(queueId: string): Promise<QueuedTerminalRun | null> {
  const rows = await db
    .select()
    .from(schema.queuedTerminalRuns)
    .where(eq(schema.queuedTerminalRuns.id, queueId))
    .limit(1);
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export async function cancelQueuedTerminalRun(queueId: string): Promise<boolean> {
  const rows = await db
    .delete(schema.queuedTerminalRuns)
    .where(and(
      eq(schema.queuedTerminalRuns.id, queueId),
      eq(schema.queuedTerminalRuns.status, 'pending'),
    ))
    .returning({ id: schema.queuedTerminalRuns.id });
  return rows.length > 0;
}

export async function listQueuedTerminalRunProjects(): Promise<string[]> {
  const rows = await db
    .select({ project: schema.queuedTerminalRuns.project })
    .from(schema.queuedTerminalRuns)
    .where(eq(schema.queuedTerminalRuns.status, 'pending'));
  return [...new Set(rows.map((r) => r.project))];
}

function rowToEntry(row: typeof schema.queuedTerminalRuns.$inferSelect): QueuedTerminalRun {
  return {
    id: row.id,
    project: row.project,
    enqueuedAt: row.enqueuedAt,
    payload: parsePayload(row.payload),
    status: row.status === 'started' ? 'started' : 'pending',
    startedJobId: row.startedJobId,
  };
}

// Drain the FIFO head for a project. If a blocking job is still running, the
// head is left in place for the next finish-seam to retry. Otherwise the
// payload is replayed through the run route and the row is marked `started`
// with the resulting job id (the originating terminal polls for that id to
// attach the live stream).
export async function drainNextTerminalRun(project: string): Promise<void> {
  if (inFlight.has(project)) return;
  inFlight.add(project);
  try {
    const pending = await listQueuedTerminalRuns(project);
    const head = pending[0];
    if (!head) return;

    const { findBlockingRunningJob } = await import('@/lib/jobs/project-active-job');
    if (await findBlockingRunningJob(project)) {
      // Still blocked — leave the head for the next drain cycle.
      return;
    }

    const port = process.env.PORT || '1337';
    const baseUrl = process.env.TAMTAM_BASE_URL || `http://localhost:${port}`;
    const url = `${baseUrl}/api/projects/by-project/${encodeURIComponent(project)}/run`;
    let r: Response;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TERMINAL_DRAIN_HEADER]: head.id,
        },
        body: JSON.stringify(head.payload),
      });
    } catch (e) {
      console.error(`[pending-terminal-run] drain fetch failed for ${project}:`, e);
      return; // keep head; next seam retries
    }

    if (r.ok) {
      const data = await r.json().catch(() => ({} as { job_id?: string }));
      const jobId = (data as { job_id?: string }).job_id ?? null;
      await db.update(schema.queuedTerminalRuns)
        .set({ status: 'started', startedJobId: jobId })
        .where(eq(schema.queuedTerminalRuns.id, head.id))
        .execute();
      console.log(`[pending-terminal-run] drained ${head.id} for ${project} → job ${jobId}`);
      // More may be queued behind this one; they remain blocked by the run we
      // just started and drain when it finishes.
      return;
    }

    const body = await r.text().catch(() => '');

    // Transient: 409 (lost the race to a job that started between the check and
    // the replay), 429 (over budget), or 5xx (server hiccup). Keep the user's
    // prompt queued — the next finish-seam (or boot recovery) retries it. We
    // never silently discard typed input on a recoverable condition.
    if (r.status === 409 || r.status === 429 || r.status >= 500) {
      console.log(
        `[pending-terminal-run] keeping ${head.id} queued for ${project}: ${r.status} ${body.slice(0, 200)}`,
      );
      return;
    }

    // Terminal failure (400 bad request, 404 project gone): the request can
    // never run as-is, so drop the head rather than wedge the queue. The user
    // can resubmit.
    await cancelQueuedTerminalRun(head.id);
    console.warn(
      `[pending-terminal-run] dropping ${head.id} for ${project}: ${r.status} ${body.slice(0, 200)}`,
    );
  } finally {
    inFlight.delete(project);
  }
}
