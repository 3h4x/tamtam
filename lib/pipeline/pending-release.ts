import { db, schema } from '@/lib/db';
import { eq, like } from 'drizzle-orm';

// Pending-release queue. When a post-agent or post-run hook tries to trigger
// a release but the project's pipeline lock is already held (or jobs are
// globally paused), we set a flag here instead of dropping the request. The
// flag is drained on two events:
//
//   1. The holding pipeline finishes (releaseLock fires drainPendingRelease).
//   2. The user resumes jobs from the header switch (syncJobsPauseState
//      walks every pending project and drains each).
//   3. Server boot or stale-lock self-heal notices a queued release whose
//      original holder vanished and retries it once the project is unlocked.
//
// Stored in the `settings` table under `pending_release:<project>=1` so we
// avoid a schema migration. Idempotent — multiple agents finishing while
// the same release is in flight all set the same flag, and the drain runs
// at most once per project.

const PREFIX = 'pending_release:';

function keyFor(project: string): string {
  return `${PREFIX}${project}`;
}

function parseQueuedAt(value: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 1) return null;
  return n * 1000;
}

export function setPendingRelease(project: string): void {
  const queuedAt = String(Date.now() / 1000);
  void db.insert(schema.settings)
    .values({ key: keyFor(project), value: queuedAt })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: queuedAt } })
    .execute()
    .catch((e) => {
      console.error('[pending-release] failed to set flag for', project, e);
    });
}

export async function getPendingRelease(project: string): Promise<boolean> {
  try {
    const rows = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, keyFor(project)))
      .limit(1);
    return !!rows[0]?.value;
  } catch {
    return false;
  }
}

export function clearPendingRelease(project: string): void {
  void deletePendingRelease(project).catch(() => { /* non-fatal */ });
}

export async function deletePendingRelease(project: string): Promise<void> {
  await db.delete(schema.settings).where(eq(schema.settings.key, keyFor(project))).execute();
}

export async function listPendingReleaseProjects(): Promise<string[]> {
  return (await listPendingReleases()).map((entry) => entry.project);
}

export async function listPendingReleases(): Promise<Array<{ project: string; queuedAt: number | null }>> {
  try {
    const rows = await db
      .select()
      .from(schema.settings)
      .where(like(schema.settings.key, `${PREFIX}%`));
    return rows
      .filter((r) => !!r.value)
      .map((r) => ({
        project: r.key.slice(PREFIX.length),
        queuedAt: parseQueuedAt(r.value),
      }));
  } catch {
    return [];
  }
}

export function shouldKeepPendingRelease(result: { ok: boolean; status?: number; detail?: string; retryable?: boolean }): boolean {
  if (result.ok) return false;
  if (result.retryable) return true;
  if (result.status === 429) return true;
  if (result.status !== 409) return false;
  const detail = result.detail ?? '';
  return detail.includes('Jobs are paused globally')
    || detail.includes('project paused')
    || detail.includes('Pipeline already running')
    || detail.includes('Release pipeline already running');
}

// Clear the flag and try to start the queued release. Async fire-and-forget
// is fine — `startRelease` is itself bounded and will gracefully no-op if
// nothing has changed since the agent finished. Errors are logged but
// shouldn't surface to the caller (drainPendingRelease is invoked from
// completion hooks where re-entry into the pipeline is incidental). Any
// indeterminate start failure (explicit retryable result or thrown error)
// re-queues the release so the next recovery path can retry it.
export async function drainPendingRelease(project: string): Promise<void> {
  if (!(await getPendingRelease(project))) return;
  try {
    await deletePendingRelease(project);
    const { dispatchReleaseWorkflow } = await import('@/lib/workflows/dispatch-release');
    const r = await dispatchReleaseWorkflow(project);
    if (r.ok) {
      console.log(`[pending-release] drained queue for ${project} → release ${r.jobId}`);
    } else if (shouldKeepPendingRelease(r)) {
      setPendingRelease(project);
      console.log(`[pending-release] drain for ${project} deferred: ${r.detail}`);
    } else {
      // 'Nothing to release' is the common no-op case — earlier in-flight
      // release already swept up the agent's changes. That's fine.
      console.log(`[pending-release] drain for ${project} produced no release: ${r.detail}`);
    }
  } catch (e) {
    setPendingRelease(project);
    console.error(`[pending-release] drain failed for ${project}:`, e);
  }
}
