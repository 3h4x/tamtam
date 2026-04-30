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
//
// Stored in the `settings` table under `pending_release:<project>=1` so we
// avoid a schema migration. Idempotent — multiple agents finishing while
// the same release is in flight all set the same flag, and the drain runs
// at most once per project.

const PREFIX = 'pending_release:';

function keyFor(project: string): string {
  return `${PREFIX}${project}`;
}

export function setPendingRelease(project: string): void {
  try {
    db.insert(schema.settings)
      .values({ key: keyFor(project), value: '1' })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: '1' } })
      .run();
  } catch (e) {
    console.error('[pending-release] failed to set flag for', project, e);
  }
}

export function getPendingRelease(project: string): boolean {
  try {
    const row = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, keyFor(project)))
      .get();
    return row?.value === '1';
  } catch {
    return false;
  }
}

export function clearPendingRelease(project: string): void {
  try {
    db.delete(schema.settings).where(eq(schema.settings.key, keyFor(project))).run();
  } catch { /* non-fatal */ }
}

export function listPendingReleaseProjects(): string[] {
  try {
    const rows = db
      .select()
      .from(schema.settings)
      .where(like(schema.settings.key, `${PREFIX}%`))
      .all();
    return rows
      .filter((r) => r.value === '1')
      .map((r) => r.key.slice(PREFIX.length));
  } catch {
    return [];
  }
}

// Clear the flag and try to start the queued release. Async fire-and-forget
// is fine — `startRelease` is itself bounded and will gracefully no-op if
// nothing has changed since the agent finished. Errors are logged but
// shouldn't surface to the caller (drainPendingRelease is invoked from
// completion hooks where re-entry into the pipeline is incidental).
export async function drainPendingRelease(project: string): Promise<void> {
  if (!getPendingRelease(project)) return;
  clearPendingRelease(project);
  try {
    const { startRelease } = await import('@/lib/pipeline/start-release');
    const r = await startRelease(project);
    if (r.ok) {
      console.log(`[pending-release] drained queue for ${project} → release ${r.jobId}`);
    } else {
      // 'Nothing to release' is the common no-op case — earlier in-flight
      // release already swept up the agent's changes. That's fine.
      console.log(`[pending-release] drain for ${project} produced no release: ${r.detail}`);
    }
  } catch (e) {
    console.error(`[pending-release] drain failed for ${project}:`, e);
  }
}
