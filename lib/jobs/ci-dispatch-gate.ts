// CI-red dispatch gate — an opt-in guard that DEFERS new scheduled-agent and
// initiative dispatch for a project whose DEFAULT-branch CI is red, until CI
// goes green again.
//
// Scope is deliberately narrow (see docs/SETTINGS.md):
//   * Gated:   scheduled (cron) agent fires + initiative dispatch — the paths
//              that spin NEW speculative work onto an already-broken build.
//   * NOT gated: releases (work still ships) and the sweep's `fix-ci` self-heal
//              — so enabling this gate can never deadlock the very mechanism
//              (`fix-ci` → `release-after-fix-ci` → green) that turns CI green.
//   * Manual operator UI runs are unaffected (this only wires the cron/
//              orchestrator dispatch paths, not the /run route directly).
//
// When self-heal can't fix a red default branch, the existing `ci_red` inbox
// HITL carries it — so a blocked project is never a silent stop (merge-or-HITL
// invariant preserved).
//
// Default-OFF and read STRAIGHT from the settings table (mirroring
// `isAutoFixCiOnRedDefaultBranchEnabled`) because the cron/orchestrator module
// realms see DEFAULTS from `getSettings()`. Fails OPEN on any gh/db error so a
// transient hiccup never freezes the fleet.

import { getDefaultBranchSync } from '@/lib/git/git-branch';
import { exec } from '@/lib/shared/shell';
import { summarizeDefaultBranchCi, type DefaultBranchRun } from '@/lib/jobs/project-sweep';

/** Read `ci_gate_block_dispatch_on_red` DIRECTLY from the DB (realm-safe). */
export async function isCiDispatchGateEnabled(): Promise<boolean> {
  try {
    const [{ db, schema }, { eq }] = await Promise.all([
      import('@/lib/db'),
      import('drizzle-orm'),
    ]);
    const row = (
      await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, 'ci_gate_block_dispatch_on_red'))
        .limit(1)
    )[0];
    return row?.value === 'true';
  } catch {
    return false;
  }
}

export interface CiGateResult {
  /** True only when the gate is enabled AND the default branch has a red run. */
  red: boolean;
  /** First failing run URL (for skip-reason / HITL context), else null. */
  failedUrl: string | null;
}

/**
 * Is the project's DEFAULT branch CI currently red? "Red" = any non-noise
 * workflow with a failing conclusion (reuses the pure `summarizeDefaultBranchCi`
 * fold the sweep uses — latest-run-per-workflow, dependabot/label filtered, so a
 * red Deploy isn't masked by a newer green test run).
 *
 * Returns `{ red: false }` when the gate is disabled or on ANY error (fail-open).
 */
export async function isDefaultBranchCiRed(projPath: string): Promise<CiGateResult> {
  const notRed: CiGateResult = { red: false, failedUrl: null };
  try {
    if (!(await isCiDispatchGateEnabled())) return notRed;
    const defaultBranch = getDefaultBranchSync(projPath) || 'main';
    const r = await exec(
      'gh',
      ['run', 'list', '--branch', defaultBranch, '--limit', '20', '--json', 'conclusion,status,workflowName,url'],
      { cwd: projPath, timeout: 8000 },
    );
    if (r.exitCode !== 0) return notRed; // fail open on gh error
    const runs = JSON.parse(r.stdout || '[]') as DefaultBranchRun[];
    const summary = summarizeDefaultBranchCi(Array.isArray(runs) ? runs : []);
    return summary.ci === 'failure' ? { red: true, failedUrl: summary.failedUrl } : notRed;
  } catch {
    return notRed;
  }
}
