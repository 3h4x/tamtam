/**
 * Flip `projects.paused = true` so admission gates (`isProjectPaused()`) stop
 * accepting new agent runs or releases on this project until a human resumes it
 * from Settings.
 *
 * Mirrors the side effects of the PATCH /api/projects/by-project/<name> route
 * without crossing the HTTP boundary — usable from inside workflow steps such as
 * the push pipeline when it hits an unresolvable state (e.g. a merge conflict).
 *
 * Uses lazy imports so merely importing this module (and its callers) does not
 * pull the DB layer into unrelated module graphs — notably unit tests that mock
 * the git/job layer but not the database.
 *
 * Returns true on success, false on any failure (already logged).
 */
// Auto-pause reason marker. Every SYSTEM pause (circuit-breaker, push-hook,
// soak) records a human-readable reason here so the inbox can surface a
// `project_paused` HITL explaining why — a silent pause is a bug (operator
// rule, mirrors merge-or-HITL). A deliberate manual pause records NO reason, so
// it does not nag. Stored in `settings` under `paused_reason:<project>` to avoid
// a schema migration; cleared on resume.
const PAUSE_REASON_PREFIX = 'paused_reason:';
// Companion to the reason: WHEN the system pause happened (epoch seconds, as a
// string). Lets the inbox DATE the `project_paused` HITL — a resumable pause with
// no age reads as stale "last year's snow." Stamped alongside the reason and
// cleared with it, so the two never drift. Stored in `settings` (no migration).
const PAUSE_AT_PREFIX = 'paused_at:';

export async function setPauseReason(project: string, reason: string): Promise<void> {
  try {
    const { db, schema } = await import('@/lib/db');
    await db.insert(schema.settings)
      .values({ key: `${PAUSE_REASON_PREFIX}${project}`, value: reason })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: reason } })
      .execute();
    // Stamp the pause moment in the same call so every recorded reason is dated.
    const at = String(Math.floor(Date.now() / 1000));
    await db.insert(schema.settings)
      .values({ key: `${PAUSE_AT_PREFIX}${project}`, value: at })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: at } })
      .execute();
  } catch (err) {
    console.error(`[pause-project] setPauseReason(${project}) failed:`, err);
  }
}

export async function clearPauseReason(project: string): Promise<void> {
  try {
    const { db, schema } = await import('@/lib/db');
    const { inArray } = await import('drizzle-orm');
    await db.delete(schema.settings)
      .where(inArray(schema.settings.key, [`${PAUSE_REASON_PREFIX}${project}`, `${PAUSE_AT_PREFIX}${project}`]))
      .execute();
  } catch { /* non-fatal */ }
}

export async function listPauseReasons(): Promise<Record<string, string>> {
  try {
    const { db, schema } = await import('@/lib/db');
    const { like } = await import('drizzle-orm');
    const rows = await db.select().from(schema.settings).where(like(schema.settings.key, `${PAUSE_REASON_PREFIX}%`));
    const out: Record<string, string> = {};
    for (const r of rows) if (r.value) out[r.key.slice(PAUSE_REASON_PREFIX.length)] = r.value;
    return out;
  } catch {
    return {};
  }
}

/** Epoch-second pause timestamps per project (from `paused_at:<project>`). */
export async function listPausedAt(): Promise<Record<string, number>> {
  try {
    const { db, schema } = await import('@/lib/db');
    const { like } = await import('drizzle-orm');
    const rows = await db.select().from(schema.settings).where(like(schema.settings.key, `${PAUSE_AT_PREFIX}%`));
    const out: Record<string, number> = {};
    for (const r of rows) {
      const n = Number(r.value);
      if (Number.isFinite(n)) out[r.key.slice(PAUSE_AT_PREFIX.length)] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export async function pauseProject(projectName: string, reason?: string): Promise<boolean> {
  try {
    const { db, schema } = await import('@/lib/db');
    const { eq } = await import('drizzle-orm');
    const { clearProjectDataCache } = await import('@/lib/shared/project-data');
    const { refreshProjectsCacheSync } = await import('@/lib/shared/enabled-projects');
    await db.update(schema.projects)
      .set({ paused: true })
      .where(eq(schema.projects.name, projectName));
    // Record WHY so the inbox surfaces a resumable HITL — no silent pauses.
    if (reason) await setPauseReason(projectName, reason);
    clearProjectDataCache();
    await refreshProjectsCacheSync();
    return true;
  } catch (err) {
    console.error(`[pause-project] pauseProject(${projectName}) failed:`, err);
    return false;
  }
}

/**
 * Inverse of {@link pauseProject}: flip `projects.paused = false` and clear any
 * recorded auto-pause reason + timestamp so the inbox `project_paused` HITL
 * self-resolves. Mirrors the resume side effects of the PATCH
 * /api/projects/by-project route without crossing the HTTP boundary — used by
 * the circuit-breaker auto-resume reconciler. Returns true on success.
 */
export async function resumeProject(projectName: string): Promise<boolean> {
  try {
    const { db, schema } = await import('@/lib/db');
    const { eq } = await import('drizzle-orm');
    const { clearProjectDataCache } = await import('@/lib/shared/project-data');
    const { refreshProjectsCacheSync } = await import('@/lib/shared/enabled-projects');
    await db.update(schema.projects)
      .set({ paused: false })
      .where(eq(schema.projects.name, projectName));
    await clearPauseReason(projectName);
    clearProjectDataCache();
    await refreshProjectsCacheSync();
    return true;
  } catch (err) {
    console.error(`[pause-project] resumeProject(${projectName}) failed:`, err);
    return false;
  }
}
