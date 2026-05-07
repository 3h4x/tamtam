// DB-backed agent-run queue for release-lock blocking.
//
// When a release pipeline holds the lock for a project, new agent runs are
// rejected and stored here instead of starting concurrently. Unlike the
// in-memory pending-agent-run queue (which handles agent-vs-agent ordering),
// this queue persists across server restarts so a queued run is never silently
// dropped because of a mid-release `pnpm restart`.
//
// Lifecycle:
//   1. Agent run route checks isLockOwnedByActiveRelease → true →
//      enqueueQueuedAgentRun → returns 202 {code:'pipeline_lock'}
//   2. When the release lock is released, pipeline-lock.ts calls
//      drainQueuedAgentRunsForProject which fires each queued agent via HTTP.
//   3. On boot (instrumentation-node.ts) stale entries whose lock is already
//      gone are drained immediately.

import { db } from '@/lib/db';
import * as schema from '@/lib/db/schema';
import { eq, asc } from 'drizzle-orm';

const activeProjectDrains = new Set<string>();

export type QueuedAgentRunEntry = {
  id: number;
  project: string;
  agentId: string;
  agentName: string;
  triggeredBy: string;
  prompt: string;
  enqueuedAt: number; // ms epoch
};

function toEntry(row: typeof schema.queuedAgentRuns.$inferSelect): QueuedAgentRunEntry {
  return { ...row, enqueuedAt: row.enqueuedAt * 1000 };
}

/** Queue an agent run, or update its prompt if already queued (idempotent per project+agentId). */
export function enqueueQueuedAgentRun(
  project: string,
  entry: Omit<QueuedAgentRunEntry, 'id'>,
): void {
  db.insert(schema.queuedAgentRuns)
    .values({
      project,
      agentId: entry.agentId,
      agentName: entry.agentName,
      triggeredBy: entry.triggeredBy,
      prompt: entry.prompt,
      enqueuedAt: entry.enqueuedAt / 1000,
    })
    .onConflictDoUpdate({
      target: [schema.queuedAgentRuns.project, schema.queuedAgentRuns.agentId],
      set: {
        agentName: entry.agentName,
        triggeredBy: entry.triggeredBy,
        prompt: entry.prompt,
        enqueuedAt: entry.enqueuedAt / 1000,
      },
    })
    .run();
}

export function listQueuedAgentRunsForProject(project: string): QueuedAgentRunEntry[] {
  try {
    return db
      .select()
      .from(schema.queuedAgentRuns)
      .where(eq(schema.queuedAgentRuns.project, project))
      .orderBy(asc(schema.queuedAgentRuns.enqueuedAt))
      .all()
      .map(toEntry);
  } catch {
    return [];
  }
}

export function listQueuedAgentRunProjects(): string[] {
  try {
    const rows = db
      .select({ project: schema.queuedAgentRuns.project })
      .from(schema.queuedAgentRuns)
      .all();
    return [...new Set(
      rows
        .map((row) => row.project)
        .filter((project): project is string => typeof project === 'string' && project.length > 0),
    )];
  } catch {
    return [];
  }
}

export function removeQueuedAgentRun(id: number): void {
  try {
    db.delete(schema.queuedAgentRuns)
      .where(eq(schema.queuedAgentRuns.id, id))
      .run();
  } catch {}
}

export function clearQueuedAgentRunsForProject(project: string): void {
  try {
    db.delete(schema.queuedAgentRuns)
      .where(eq(schema.queuedAgentRuns.project, project))
      .run();
  } catch {}
}

type QueueDrainResponse = {
  code?: string;
  detail?: string;
};

function parseQueueDrainResponse(raw: string): QueueDrainResponse | null {
  try {
    return raw ? JSON.parse(raw) as QueueDrainResponse : null;
  } catch {
    return null;
  }
}

function shouldKeepQueuedRunOn409(parsed: QueueDrainResponse | null, raw: string): boolean {
  const code = parsed?.code ?? '';
  if (
    code === 'already_running' ||
    code === 'already_starting' ||
    code === 'project_busy' ||
    code === 'jobs_paused' ||
    code === 'issue_branch'
  ) {
    return true;
  }
  return (parsed?.detail ?? raw).includes('Jobs are paused globally');
}

function shouldKeepQueuedRunOn202(parsed: QueueDrainResponse | null): boolean {
  const code = parsed?.code ?? '';
  return code === 'pipeline_lock' || code === 'pending_release';
}

/**
 * Trigger all DB-queued agents for a project by calling their run endpoints.
 * Called after the release pipeline lock is released (or at boot for stale entries).
 *
 * On success (200) or hand-off to in-memory queue (202 without pipeline_lock):
 * remove from DB.
 * On terminal error (400/404): drop the entry.
 * On transient error (202 pipeline_lock, 409 pause/conflict, 429, 5xx,
 * timeout): leave in DB for the next drain.
 */
export async function drainQueuedAgentRunsForProject(project: string): Promise<void> {
  if (activeProjectDrains.has(project)) return;
  activeProjectDrains.add(project);
  try {
    const queued = listQueuedAgentRunsForProject(project);
    if (queued.length === 0) return;

    const port = process.env.PORT || '1337';
    const baseUrl = process.env.TAMTAM_BASE_URL || `http://localhost:${port}`;

    for (const entry of queued) {
      try {
        const url = `${baseUrl}/api/agents/${encodeURIComponent(entry.agentId)}/run`;
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tamtam-trigger': entry.triggeredBy,
          },
          body: JSON.stringify({ prompt: entry.prompt }),
        });
        if (r.ok || r.status === 202) {
          const raw = await r.text().catch(() => '');
          const parsed = parseQueueDrainResponse(raw);
          if (shouldKeepQueuedRunOn202(parsed)) {
            console.log(
              `[queued-agent-runs] keeping ${entry.agentName} queued for ${project}: ${r.status} ${parsed?.code ?? 'queued'} ${(parsed?.detail ?? raw).slice(0, 200)}`,
            );
            continue;
          }
          // 200: started. 202: another agent is running — handed off to
          // in-memory queue which will drain when that agent finishes.
          removeQueuedAgentRun(entry.id);
          console.log(`[queued-agent-runs] drained ${entry.agentName} for ${project} (${r.status})`);
          continue;
        }
        if (r.status === 409) {
          const raw = await r.text().catch(() => '');
          const parsed = parseQueueDrainResponse(raw);
          if (shouldKeepQueuedRunOn409(parsed, raw)) {
            console.warn(
              `[queued-agent-runs] keeping ${entry.agentName} queued for ${project}: ${r.status} ${(parsed?.code ?? 'transient_409')} ${(parsed?.detail ?? raw).slice(0, 200)}`,
            );
            continue;
          }
          removeQueuedAgentRun(entry.id);
          console.warn(
            `[queued-agent-runs] dropping ${entry.agentName} for ${project}: ${r.status} ${(parsed?.code ?? 'terminal_409')} ${(parsed?.detail ?? raw).slice(0, 200)}`,
          );
          continue;
        }
        if (r.status === 400 || r.status === 404) {
          removeQueuedAgentRun(entry.id);
          const body = await r.text().catch(() => '');
          console.warn(`[queued-agent-runs] dropping ${entry.agentName} for ${project}: ${r.status} ${body.slice(0, 200)}`);
          continue;
        }
        // Transient (5xx, 429, etc.) — keep in DB, next drain will retry.
        const body = await r.text().catch(() => '');
        console.warn(`[queued-agent-runs] transient failure for ${entry.agentName}/${project}: ${r.status} ${body.slice(0, 200)}`);
      } catch (e) {
        console.error(`[queued-agent-runs] drain error for ${project}/${entry.agentName}:`, e);
      }
    }
  } finally {
    activeProjectDrains.delete(project);
  }
}

export async function drainQueuedAgentRunsForUnlockedProjects(
  logPrefix = '[queued-agent-runs]',
): Promise<void> {
  const { drainUnlockedQueuedAgentRuns } = await import('@/lib/pipeline/recovery-drain');
  await drainUnlockedQueuedAgentRuns(logPrefix);
}
