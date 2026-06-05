// Retention sweep for the file-backed local workflow world. The Postgres
// sweep (`workflow-retention.ts`) only trims `workflow.workflow_*` tables;
// with `WORKFLOW_TARGET_WORLD=local` the runtime instead writes one JSON file
// per run under `<data>/runs/` and one per step under `<data>/steps/`, and it
// never deletes them. Left unchecked these dirs grow into tens of thousands
// of files, which both balloons disk and slows the /workflow-runs endpoints
// that must `readdirSync` them. This sweep deletes the run + step files for
// terminal runs whose completion predates the cutoff.
//
// Invoked from the same daily `runCleanup` in instrumentation-node.ts that
// drives the Postgres sweep; the two are mutually exclusive by world.

import { readdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { localWorldRunsDir, localWorldStepsDir, type LocalRunFile } from '@/lib/workflows/local-world-runs';

const ULID_TIME_CHARS = 10;
// Crockford base32 — the ULID alphabet (no I, L, O, U).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Decode the creation timestamp (ms) encoded in a run ULID. Run IDs look like
// `wrun_01KSK46HG2NX2KQ5AGR3GZYV0W`; the 26-char ULID after the prefix carries
// its 48-bit ms timestamp in the leading 10 chars. Returns null for names that
// aren't ULID-shaped (legacy/foreign) so callers fall back to reading the file.
export function decodeUlidTimeMs(runId: string): number | null {
  const underscore = runId.indexOf('_');
  const ulid = underscore >= 0 ? runId.slice(underscore + 1) : runId;
  if (ulid.length < ULID_TIME_CHARS) return null;
  let t = 0;
  for (let i = 0; i < ULID_TIME_CHARS; i++) {
    const v = CROCKFORD.indexOf(ulid[i]!.toUpperCase());
    if (v < 0) return null;
    t = t * 32 + v;
  }
  return t;
}

export interface LocalRetentionSummary {
  status: 'completed' | 'disabled' | 'failed';
  retentionDays: number;
  cutoffIso: string;
  runsDeleted: number;
  stepsDeleted: number;
  errorCount: number;
  lastError: string | null;
  durationMs: number;
}

export interface LocalPruneOptions {
  retentionDays: number;
  /** Override the clock — useful in tests. */
  now?: () => number;
}

export function pruneLocalWorldRuns(opts: LocalPruneOptions): LocalRetentionSummary {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const summary: LocalRetentionSummary = {
    status: 'completed',
    retentionDays: opts.retentionDays,
    cutoffIso: '',
    runsDeleted: 0,
    stepsDeleted: 0,
    errorCount: 0,
    lastError: null,
    durationMs: 0,
  };

  if (opts.retentionDays <= 0) {
    summary.status = 'disabled';
    summary.durationMs = now() - startedAt;
    return summary;
  }

  const cutoffMs = now() - opts.retentionDays * 86_400_000;
  summary.cutoffIso = new Date(cutoffMs).toISOString();

  const runsDir = localWorldRunsDir();
  const stepsDir = localWorldStepsDir();

  let runNames: string[];
  try {
    runNames = readdirSync(/*turbopackIgnore: true*/ runsDir).filter((n) => n.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      summary.durationMs = now() - startedAt;
      return summary;
    }
    summary.status = 'failed';
    summary.errorCount += 1;
    summary.lastError = (err as Error).message;
    summary.durationMs = now() - startedAt;
    return summary;
  }

  const deletable = new Set<string>();
  for (const name of runNames) {
    const runId = name.replace(/\.json$/, '');
    // Cheap pre-filter: createdAt <= completedAt always, so a run whose
    // ULID creation time is newer than the cutoff cannot have completed
    // before it — skip without a file read. After the first sweep this
    // short-circuits the vast majority of files.
    const createdMs = decodeUlidTimeMs(runId);
    if (createdMs != null && createdMs >= cutoffMs) continue;

    let run: LocalRunFile;
    try {
      run = JSON.parse(readFileSync(/*turbopackIgnore: true*/ join(runsDir, name), 'utf8')) as LocalRunFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      summary.errorCount += 1;
      summary.lastError = (err as Error).message;
      continue;
    }

    // Only terminal runs are pruned. An old run that never completed is left
    // in place — mirrors the Postgres sweep's `completed_at IS NOT NULL` gate
    // so an active or stuck run is never deleted out from under the runtime.
    const completedMs = run.completedAt ? Date.parse(run.completedAt) : NaN;
    if (Number.isFinite(completedMs) && completedMs < cutoffMs) {
      deletable.add(runId);
    }
  }

  if (deletable.size === 0) {
    summary.durationMs = now() - startedAt;
    return summary;
  }

  // Step files are flat: `${runId}-step_${stepId}.json`. Run IDs contain no
  // dash, so the substring before the first '-' is the owning run. One pass
  // over the steps dir deletes every step belonging to a pruned run.
  try {
    for (const stepName of readdirSync(/*turbopackIgnore: true*/ stepsDir)) {
      if (!stepName.endsWith('.json')) continue;
      const dash = stepName.indexOf('-');
      if (dash < 0) continue;
      if (!deletable.has(stepName.slice(0, dash))) continue;
      try {
        unlinkSync(/*turbopackIgnore: true*/ join(stepsDir, stepName));
        summary.stepsDeleted += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          summary.errorCount += 1;
          summary.lastError = (err as Error).message;
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      summary.errorCount += 1;
      summary.lastError = (err as Error).message;
    }
  }

  for (const runId of deletable) {
    try {
      unlinkSync(/*turbopackIgnore: true*/ join(runsDir, `${runId}.json`));
      summary.runsDeleted += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        summary.errorCount += 1;
        summary.lastError = (err as Error).message;
      }
    }
  }

  if (summary.errorCount > 0 && summary.runsDeleted === 0) summary.status = 'failed';
  summary.durationMs = now() - startedAt;
  return summary;
}
