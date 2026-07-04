// Shared "dispatch a bounded fix-ci for a red default branch" helper.
//
// Used by both the project sweep (idle-on-default-branch trigger) and the
// post-merge soak watcher (the timing-gap-proof trigger — soak polls the merge
// SHA's default-branch CI over a window, so it observes the failure whenever it
// surfaces, unlike the sweep which needs the repo to still be idle on default).
//
// Bounding lives in `auto-fix-ci-state.ts`: one attempt per failing-run URL,
// capped consecutive attempts, so a permanently-broken CI cannot loop. On a
// refusal the caller falls back to its own HITL (sweep → ci_red inbox signal;
// soak → revert PR + project pause).

export interface DispatchAutoFixCiResult {
  dispatched: boolean;
  detail: string;
}

/**
 * Seed `gh_status.ci_failed_url` with the failing default-branch run, then POST
 * the existing fix-ci route (single source of truth for prompt construction,
 * gating, and permission mode). Bounded per failing run. `log` receives a
 * human-readable trace line for the caller's job log.
 */
export async function dispatchAutoFixCiForRedDefaultBranch(
  projectName: string,
  failedUrl: string | null,
  log?: (line: string) => void,
): Promise<DispatchAutoFixCiResult> {
  const trace = (s: string) => { try { log?.(s); } catch { /* non-fatal */ } };
  try {
    const {
      decideAutoFixCi,
      getAutoFixCiEntry,
      setAutoFixCiEntry,
      getAutoFixCiMaxAttempts,
    } = await import('@/lib/jobs/auto-fix-ci-state');

    const decision = decideAutoFixCi(getAutoFixCiEntry(projectName), failedUrl, getAutoFixCiMaxAttempts());
    if (!decision.dispatch) {
      trace(`\n# auto fix-ci bounded — ${decision.reason}\n`);
      return { dispatched: false, detail: decision.reason };
    }

    // fix-ci reads gh_status.ci_failed_url; seed it (it 400s without a URL).
    try {
      const { db, schema } = await import('@/lib/db');
      const fetchedAt = new Date().toISOString();
      await db.insert(schema.ghStatus)
        .values({ project: projectName, ciFailedUrl: failedUrl, fetchedAt })
        .onConflictDoUpdate({ target: schema.ghStatus.project, set: { ciFailedUrl: failedUrl, fetchedAt } })
        .execute();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      trace(`\n# auto fix-ci: could not seed ci_failed_url: ${msg}\n`);
      return { dispatched: false, detail: `could not seed ci_failed_url: ${msg}` };
    }

    const port = parseInt(process.env.PORT ?? '', 10) || 1337;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/projects/by-project/${encodeURIComponent(projectName)}/fix-ci`,
      { method: 'POST' },
    );
    const body = await res.text().catch(() => '');
    trace(`\n# auto fix-ci dispatch — ${res.status} ${body.slice(0, 150)}\n`);
    if (res.ok) {
      // Count the attempt so the same failing run isn't re-dispatched.
      if (decision.next) setAutoFixCiEntry(projectName, decision.next);
      return { dispatched: true, detail: `fix-ci dispatched (${res.status})` };
    }
    // 409 (already running) / 429 (budget) / etc. are transient: don't burn the
    // per-run attempt budget, let the caller's fallback / a later pass retry.
    return { dispatched: false, detail: `fix-ci route ${res.status}: ${body.slice(0, 120)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    trace(`\n# auto fix-ci dispatch error: ${msg}\n`);
    return { dispatched: false, detail: msg };
  }
}
