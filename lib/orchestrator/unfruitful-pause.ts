// Auto-pause "caught up / unfruitful" projects.
//
// Some projects keep firing scheduled agents that have nothing left to do —
// e.g. a `refactor-split` agent whose prerequisite repeatedly reports "no
// eligible oversized split target", producing zero diffs run after run. That
// burns budget and (on macOS) hammers syspolicyd/git with a process storm for
// no value. When a project's recent scheduled runs are ALL no-diff AND at least
// one explicitly reports nothing-to-do, we pause the project so it stops
// churning until a human resumes it (or new work appears).
//
// Pure functions for the detection (unit-tested); the action takes injected
// deps so it stays DB-free and testable.

import type { JobData } from '@/lib/jobs/types';
import { IDLE_SUMMARY_RE } from '@/lib/orchestrator/agent-health-analysis';

interface AgentContextMeta {
  agent?: {
    triggeredBy?: string;
  };
}

function parseAgentMeta(rawMeta: string | null | undefined): AgentContextMeta | null {
  if (!rawMeta) return null;
  try {
    return JSON.parse(rawMeta) as AgentContextMeta;
  } catch {
    return null;
  }
}

function isScheduledAgentRun(run: JobData): boolean {
  return parseAgentMeta(run.contextMeta)?.agent?.triggeredBy === 'schedule';
}

function effectiveThreshold(threshold: number): number {
  return threshold <= 0 ? 1 : threshold;
}

/** A finished agent run that produced no code change at all. */
export function runProducedNoDiff(run: JobData): boolean {
  const lines = (run.linesAdded ?? 0) + (run.linesRemoved ?? 0);
  const mf = run.modifiedFiles;
  const hasFiles = !!mf && mf !== '[]' && mf !== '' && mf !== '0';
  return lines === 0 && !hasFiles;
}

/** A run whose work summary explicitly reports nothing to do (caught up). */
export function runIsCaughtUp(run: JobData): boolean {
  return IDLE_SUMMARY_RE.test(run.workSummary ?? '');
}

/** A run that completed without producing value: it succeeded (exit 0) or
 *  explicitly reported nothing to do. Used inside an all-no-diff window to tell
 *  a genuinely caught-up project (agents finish fine but produce nothing — e.g.
 *  blog-writer "found no material", refactor-split "no eligible target") from a
 *  streak of host-load CRASHES (all exit ≠ 0, empty summaries) which needs
 *  attention, not silencing. */
function runIsCaughtUpOrCleanNoop(run: JobData): boolean {
  return runIsCaughtUp(run) || run.exitCode === 0;
}

/**
 * True when a project is caught up / unfruitful: its most recent `threshold`
 * finished scheduled agent runs ALL produced no diff AND at least one of them
 * completed cleanly with nothing to produce (an explicit nothing-to-do summary,
 * or a successful exit-0 run that changed nothing). The clean-completion
 * requirement excludes a project that is merely crashing transiently (e.g.
 * host-load killing every agent) — that needs attention, not silencing.
 */
export function isProjectCaughtUpUnfruitful(
  recentRunsNewestFirst: JobData[],
  threshold: number,
): boolean {
  const requiredRuns = effectiveThreshold(threshold);
  const window = recentRunsNewestFirst.slice(0, requiredRuns);
  if (window.length < requiredRuns) return false; // not enough history yet
  if (window.some((r) => !runProducedNoDiff(r))) return false; // a fruitful run → still has work
  return window.some(runIsCaughtUpOrCleanNoop); // ≥1 clean no-op (caught up, not crashing)
}

/** Finished scheduled agent runs for one project, newest-first. */
export function recentScheduledAgentRuns(
  allJobs: JobData[],
  project: string,
  isAgentJobKind: (kind: unknown) => boolean,
  limit: number,
): JobData[] {
  return allJobs
    .filter((j) => j.project === project && j.finishedAt != null && isAgentJobKind(j.kind) && isScheduledAgentRun(j))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, limit);
}

export interface UnfruitfulPauseDeps {
  /** `auto_pause_unfruitful_enabled` */
  enabled: boolean;
  /** `auto_pause_unfruitful_runs` — consecutive no-diff runs before pausing. */
  threshold: number;
  listJobs: () => JobData[];
  isAgentJobKind: (kind: unknown) => boolean;
  /** Enabled (non-archived) projects with their current paused flag. */
  listProjects: () => Array<{ name: string; paused?: boolean }>;
  pauseProject: (name: string) => Promise<boolean>;
  recommend: (input: { project: string; title: string; detail: string }) => Promise<unknown>;
  notify?: (project: string, threshold: number) => Promise<void> | void;
  log?: (msg: string) => void;
}

export interface UnfruitfulPauseResult {
  paused: string[];
}

/**
 * Scan enabled, non-paused projects; pause any that are caught-up/unfruitful and
 * record a recommendation explaining why. Idempotent: a paused project is
 * skipped, so it only fires once per caught-up streak.
 */
export async function autoPauseUnfruitfulProjects(
  deps: UnfruitfulPauseDeps,
): Promise<UnfruitfulPauseResult> {
  const paused: string[] = [];
  if (!deps.enabled) return { paused };

  const requiredRuns = effectiveThreshold(deps.threshold);
  const jobs = deps.listJobs();
  for (const p of deps.listProjects()) {
    if (p.paused) continue;
    const runs = recentScheduledAgentRuns(jobs, p.name, deps.isAgentJobKind, requiredRuns);
    if (!isProjectCaughtUpUnfruitful(runs, deps.threshold)) continue;

    const ok = await deps.pauseProject(p.name);
    if (!ok) continue;
    paused.push(p.name);

    try {
      await deps.recommend({
        project: p.name,
        title: `${p.name} auto-paused — caught up (nothing to do)`,
        detail:
          `The last ${requiredRuns} scheduled agent runs produced no changes and at least one ` +
          `reported nothing to do. TamTam paused the project to stop it churning agents (and the ` +
          `process/syspolicyd load that comes with them) for no value. Resume it from Settings when ` +
          `there is new work, or lower its cadence.`,
      });
    } catch (e) {
      deps.log?.(`[unfruitful-pause] recommendation failed for ${p.name}: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (deps.notify) {
      try {
        await deps.notify(p.name, requiredRuns);
      } catch { /* notification failure is non-fatal */ }
    }
    deps.log?.(`[unfruitful-pause] auto-paused ${p.name} (${requiredRuns} caught-up/no-diff runs)`);
  }
  return { paused };
}

/**
 * Runtime entry: wire `autoPauseUnfruitfulProjects` with real deps. Lazy imports
 * keep the pure functions above (and their tests) free of the DB/job layer.
 * Safe to call from a background sweep — no-ops when the setting is off.
 */
export async function runUnfruitfulPauseSweep(): Promise<UnfruitfulPauseResult> {
  const { getSettings } = await import('@/lib/shared/config');
  const s = getSettings();
  if (!s.auto_pause_unfruitful_enabled) return { paused: [] };

  const [{ listJobs }, { isAgentJobKind }, { listEnabledProjects }, { pauseProject }, { upsertRecommendation }] =
    await Promise.all([
      import('@/lib/jobs/job-storage'),
      import('@/lib/jobs/kinds'),
      import('@/lib/shared/enabled-projects'),
      import('@/lib/pipeline/pause-project'),
      import('@/lib/recommendations/recommendations'),
    ]);

  return autoPauseUnfruitfulProjects({
    enabled: s.auto_pause_unfruitful_enabled,
    threshold: s.auto_pause_unfruitful_runs,
    listJobs,
    isAgentJobKind,
    listProjects: () => listEnabledProjects().map((p) => ({ name: p.name, paused: !!p.paused })),
    pauseProject,
    recommend: (input) =>
      upsertRecommendation({
        project: input.project,
        sourceKind: 'orchestrator',
        type: 'auto_pause_unfruitful',
        title: input.title,
        detail: input.detail,
      }),
    log: (m) => console.log(m),
  });
}
