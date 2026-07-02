// Per-agent "saturation" backoff. The project-level auto-pause
// (`lib/orchestrator/unfruitful-pause.ts`) only silences a project when ALL its
// recent scheduled runs are unfruitful — so a single agent that has run out of
// work (e.g. a `refactor-ui` agent whose target layer is "saturated": every
// run scans, finds nothing, lands a 0-line no-op) keeps firing on its schedule
// as long as OTHER agents in the same project still ship diffs. That burns
// budget and (on macOS) churns git/syspolicyd for no value.
//
// This module adds the per-agent analog: when a single agent is persistently
// unfruitful AND no new commit has landed since it last ran, the scheduled
// fire is skipped (the cron self-reenqueue keeps the schedule ticking, so the
// agent re-checks next tick — cheap, no agent dispatch). The HEAD gate is the
// release valve: any new commit lets the agent run once and re-evaluate, so it
// is never silenced permanently — it just stops re-scanning an unchanged tree.
//
// Pure functions (unit-tested); the wiring in the agent-cron `prereqSkipReason`
// injects the live job list + current HEAD.

import type { JobData } from '@/lib/jobs/types';
import { runWasProductive, runIsCaughtUp } from '@/lib/orchestrator/unfruitful-pause';

/** The HEAD sha a scheduled run executed against, recorded by the intake
 *  workflow in `contextMeta.baseline.head`. Null when absent/unparseable. */
export function agentRunBaselineHead(run: JobData): string | null {
  const raw = run.contextMeta;
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw) as { baseline?: { head?: unknown } };
    const head = meta?.baseline?.head;
    return typeof head === 'string' && head.length > 0 ? head : null;
  } catch {
    return null;
  }
}

function isScheduledRun(run: JobData): boolean {
  try {
    const meta = JSON.parse(run.contextMeta ?? 'null') as { agent?: { triggeredBy?: string } } | null;
    return meta?.agent?.triggeredBy === 'schedule';
  } catch {
    return false;
  }
}

/** Finished scheduled runs for ONE agent (matched by its `agent:<name>` job
 *  kind) within a project, newest-first. */
export function recentScheduledRunsForAgent(
  allJobs: JobData[],
  project: string,
  agentKind: string,
  isAgentJobKind: (kind: unknown) => boolean,
  getJobKind: (kind: unknown) => string,
  limit: number,
): JobData[] {
  return allJobs
    .filter(
      (j) =>
        j.project === project &&
        j.finishedAt != null &&
        isAgentJobKind(j.kind) &&
        getJobKind(j.kind) === agentKind &&
        isScheduledRun(j),
    )
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, limit);
}

/**
 * True when a single agent is "saturated" and should skip this scheduled fire:
 *   - its most recent `sample` finished scheduled runs all exist (enough
 *     history), and
 *   - the fruitful rate (runs that changed code lines OR dispatched a triage
 *     action such as merging a PR / closing an issue, over total) is below
 *     `rateThreshold`, and
 *   - the most recent run executed against the CURRENT HEAD — i.e. no new
 *     commit has landed since it last looked (the release valve: a HEAD move
 *     re-enables it), and
 *   - at least one run in the window completed cleanly (exit 0 or an explicit
 *     caught-up summary), so a pure crash streak — which needs attention, not
 *     silencing — does not trip this.
 *
 * Disabled when `rateThreshold <= 0`, `sample <= 0`, or `currentHead` is
 * unknown (never silence an agent blind).
 */
export function isAgentSaturated(
  recentRunsNewestFirst: JobData[],
  currentHead: string | null,
  sample: number,
  rateThreshold: number,
): boolean {
  if (rateThreshold <= 0 || sample <= 0 || !currentHead) return false;
  const window = recentRunsNewestFirst.slice(0, sample);
  if (window.length < sample) return false; // not enough history yet
  // HEAD must be unchanged since the agent last ran — otherwise new work may
  // exist and the agent deserves a fresh look.
  const lastHead = agentRunBaselineHead(window[0]);
  if (!lastHead || lastHead !== currentHead) return false;
  const fruitful = window.filter(runWasProductive).length;
  if (fruitful / window.length >= rateThreshold) return false; // still productive enough
  return window.some((r) => r.exitCode === 0 || runIsCaughtUp(r)); // ≥1 clean run
}
