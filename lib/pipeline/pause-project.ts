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
export async function pauseProject(projectName: string): Promise<boolean> {
  try {
    const { db, schema } = await import('@/lib/db');
    const { eq } = await import('drizzle-orm');
    const { clearProjectDataCache } = await import('@/lib/shared/project-data');
    const { refreshProjectsCacheSync } = await import('@/lib/shared/enabled-projects');
    await db.update(schema.projects)
      .set({ paused: true })
      .where(eq(schema.projects.name, projectName));
    clearProjectDataCache();
    await refreshProjectsCacheSync();
    return true;
  } catch (err) {
    console.error(`[pause-project] pauseProject(${projectName}) failed:`, err);
    return false;
  }
}
