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

/** A run that produced a real line-level change. Stricter than `runProducedNoDiff`:
 *  a run that "touches" files but moves zero lines (an agent rewriting a file to
 *  identical content — a 0-line no-op edit) counts as unproductive here, because
 *  it lands nothing committable. This is the right signal for the rate-based
 *  waste check, which exists precisely to catch projects that keep re-touching
 *  files for no net change. (The caught-up path keeps `runProducedNoDiff`'s
 *  files-or-lines semantics so it never silences a project doing legitimate
 *  binary/rename changes.) */
export function runChangedLines(run: JobData): boolean {
  return ((run.linesAdded ?? 0) + (run.linesRemoved ?? 0)) > 0;
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

/**
 * True when a project is *persistently* unfruitful: over its most recent
 * `sample` finished scheduled runs, the fruitful rate (runs that changed code /
 * total) is below `rateThreshold`, and at least one of them completed cleanly
 * (so a streak of host-load crashes — which needs attention — does not silence
 * the project). This complements `isProjectCaughtUpUnfruitful`: that one needs
 * an unbroken all-no-diff window, so a project that lands a diff once every few
 * runs slips through even while grinding tokens for almost nothing. The rate
 * check catches that interspersed-churn case. Mirrors the per-agent autopilot
 * threshold so project- and agent-level "unfruitful" agree. Disabled when
 * `rateThreshold <= 0`.
 */
export function isProjectPersistentlyUnfruitful(
  recentRunsNewestFirst: JobData[],
  sample: number,
  rateThreshold: number,
): boolean {
  if (rateThreshold <= 0) return false;
  if (sample <= 0) return false;
  const window = recentRunsNewestFirst.slice(0, sample);
  if (window.length < sample) return false; // not enough history to judge a rate
  // Line-level fruitfulness: a run that re-touches files but moves zero lines is
  // unproductive churn, not real work (see runChangedLines).
  const fruitful = window.filter(runChangedLines).length;
  const rate = fruitful / window.length;
  if (rate >= rateThreshold) return false; // still productive enough
  return window.some(runIsCaughtUpOrCleanNoop); // ≥1 clean run (not all crashing)
}

/** The sample size for the rate-based check: wider than the strict caught-up
 *  window so the rate is stable, but bounded so it reacts within a reasonable
 *  number of runs. */
export function unfruitfulRateSample(threshold: number): number {
  return Math.max(effectiveThreshold(threshold) * 2, 10);
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
  /** `auto_pause_unfruitful_rate` — fruitful-rate floor for the rate-based
   *  trigger (over `unfruitfulRateSample(threshold)` runs). 0 disables it,
   *  leaving only the strict all-no-diff caught-up path. */
  rateThreshold: number;
  listJobs: () => JobData[];
  isAgentJobKind: (kind: unknown) => boolean;
  /** Optional: keep only runs from agents that are STILL enabled for the
   *  project. When an operator disables the unfruitful agents (curating a
   *  project down to, say, only issue-cruncher), those stopped agents' past
   *  no-diff runs must not keep the project paused — the auto-pause should
   *  judge only the currently-enabled agent set. Runs whose `agent:<name>`
   *  kind maps to no enabled agent are dropped before the rate/caught-up
   *  checks. Absent → count all runs (legacy behavior). */
  isEnabledAgentRun?: (project: string, kind: string) => boolean;
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
  const sample = unfruitfulRateSample(deps.threshold);
  // Fetch wider than the sample so that, after dropping runs from now-disabled
  // agents, enough enabled-agent history usually remains to judge a rate.
  const fetchLimit = Math.max(requiredRuns, sample) * 4;
  const jobs = deps.listJobs();
  for (const p of deps.listProjects()) {
    if (p.paused) continue;
    let runs = recentScheduledAgentRuns(jobs, p.name, deps.isAgentJobKind, fetchLimit);
    if (deps.isEnabledAgentRun) {
      runs = runs.filter((r) => deps.isEnabledAgentRun!(p.name, String(r.kind)));
    }
    const caughtUp = isProjectCaughtUpUnfruitful(runs, deps.threshold);
    const lowRate = !caughtUp && isProjectPersistentlyUnfruitful(runs, sample, deps.rateThreshold);
    if (!caughtUp && !lowRate) continue;

    const ok = await deps.pauseProject(p.name);
    if (!ok) continue;
    paused.push(p.name);

    const ratePct = sample > 0
      ? Math.round((runs.slice(0, sample).filter(runChangedLines).length / sample) * 100)
      : 0;
    const title = caughtUp
      ? `${p.name} auto-paused — caught up (nothing to do)`
      : `${p.name} auto-paused — persistently unfruitful (${ratePct}% of runs produce changes)`;
    const detail = caughtUp
      ? `The last ${requiredRuns} scheduled agent runs produced no changes and at least one ` +
        `reported nothing to do. TamTam paused the project to stop it churning agents (and the ` +
        `process/syspolicyd load that comes with them) for no value. Resume it from Settings when ` +
        `there is new work, or lower its cadence.`
      : `Only ${ratePct}% of the last ${sample} scheduled agent runs produced any change — below the ` +
        `${Math.round(deps.rateThreshold * 100)}% auto-pause floor. The project keeps firing agents that ` +
        `mostly produce nothing, burning budget and process/syspolicyd load. TamTam paused it; resume ` +
        `from Settings, lower its cadence, or fix the agents that aren't landing work.`;
    try {
      await deps.recommend({ project: p.name, title, detail });
    } catch (e) {
      deps.log?.(`[unfruitful-pause] recommendation failed for ${p.name}: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (deps.notify) {
      try {
        await deps.notify(p.name, requiredRuns);
      } catch { /* notification failure is non-fatal */ }
    }
    deps.log?.(`[unfruitful-pause] auto-paused ${p.name} (${caughtUp ? `${requiredRuns} caught-up/no-diff runs` : `low fruitful rate ${ratePct}% over ${sample} runs`})`);
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

  const [{ listJobs }, { isAgentJobKind }, { listEnabledProjects }, { pauseProject }, { upsertRecommendation }, { getAllAgentsCached }] =
    await Promise.all([
      import('@/lib/jobs/job-storage'),
      import('@/lib/jobs/kinds'),
      import('@/lib/shared/enabled-projects'),
      import('@/lib/pipeline/pause-project'),
      import('@/lib/recommendations/recommendations'),
      import('@/lib/agents/agents-cache'),
    ]);

  // Set of currently-enabled `<project>\0agent:<name>` kinds, so the auto-pause
  // judges a project only by agents the operator still has enabled — a disabled
  // agent's past no-diff runs no longer keep the project paused.
  const enabledAgentKinds = new Set<string>();
  for (const a of getAllAgentsCached()) {
    if (a.enabled) enabledAgentKinds.add(`${a.project} agent:${a.name}`);
  }

  return autoPauseUnfruitfulProjects({
    enabled: s.auto_pause_unfruitful_enabled,
    threshold: s.auto_pause_unfruitful_runs,
    rateThreshold: s.auto_pause_unfruitful_rate,
    listJobs,
    isAgentJobKind,
    isEnabledAgentRun: (project, kind) => enabledAgentKinds.has(`${project} ${kind}`),
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
