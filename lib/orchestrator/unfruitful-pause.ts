// Auto-disable "caught up / unfruitful" AGENTS (never whole projects).
//
// Some agents keep firing on their schedule with nothing left to do — e.g. a
// `refactor-split` producer whose prerequisite repeatedly reports "no eligible
// oversized split target", producing zero diffs run after run. That burns
// budget and (on macOS) hammers syspolicyd/git with a process storm for no
// value. Rather than pause the whole project (which also silences its healthy
// agents, issue/PR work, manual runs, and releases), we disable only the
// specific offending agent and record a recommendation. The project stays
// alive; the operator re-enables the agent from its page when there is new work.
//
// Scope guards keep this from silencing agents that are idle by design:
//   - Only `producer`-role agents are judged by diffs; a no-diff run is the
//     expected outcome for a monitor/reviewer/planner/publisher (see roles.ts).
//   - System agents are exempt.
//   - Externally-gated producers (issue/PR triage such as issue-cruncher) are
//     exempt: a no-diff stretch means "no open work right now", not waste.
//
// Pure functions for the detection (unit-tested); the action takes injected
// deps so it stays DB-free and testable.

import type { JobData } from '@/lib/jobs/types';
import type { AgentRole } from '@/lib/agents/roles';
import { IDLE_SUMMARY_RE } from '@/lib/orchestrator/agent-health-analysis';

interface AgentContextMeta {
  agent?: {
    triggeredBy?: string;
  };
  // Persisted by the agent-completion hook after it dispatches the run's
  // `tamtam-actions` block server-side (issue close, PR merge, label/comment).
  // `executed` is the count of actions that ran successfully.
  agentActions?: {
    executed?: number;
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

/** A run that dispatched at least one server-side agent action (issue close,
 *  PR merge, needs-info label/comment). These are the productive outcomes of
 *  issue/PR-triage agents that legitimately change ZERO code lines — merging a
 *  ready PR or closing a done/stale issue drains the backlog without a diff.
 *  Without this credit, a working issue-cruncher looks identical to a
 *  do-nothing agent (both land no lines) and gets auto-paused precisely when it
 *  is succeeding. The `agentActions.executed` count is persisted by the
 *  agent-completion hook after it dispatches the run's `tamtam-actions` block,
 *  so this signal is available retroactively on past runs. Runs that found
 *  nothing to do (no eligible issue) dispatch no actions and are correctly NOT
 *  credited here. */
export function runDispatchedAction(run: JobData): boolean {
  const executed = parseAgentMeta(run.contextMeta)?.agentActions?.executed;
  return typeof executed === 'number' && executed > 0;
}

/** A run that produced value: a real line-level change OR a dispatched agent
 *  action. This is the fruitfulness signal the rate-based unfruitful checks use,
 *  so triage-only work (merge/close with no diff) counts as productive. */
export function runWasProductive(run: JobData): boolean {
  return runChangedLines(run) || runDispatchedAction(run);
}

/** A scheduled run that is externally-gated triage/queue work: it targeted a
 *  GitHub issue/PR, or it dispatched a server-side action (merge/close/label).
 *  An agent with ANY such run in its recent window is waiting on an external
 *  backlog — its no-diff "nothing to do" stretches are expected, not waste — so
 *  it must never be auto-disabled (that would stop it picking up new issues). */
export function runIsExternallyGated(run: JobData): boolean {
  return run.ghIssueNumber != null || runDispatchedAction(run);
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
  // A run that landed a diff OR dispatched a triage action (merge/close) is
  // productive → the project still has work and is not caught up.
  if (window.some((r) => !runProducedNoDiff(r) || runDispatchedAction(r))) return false;
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
  // Fruitfulness: a run that moved lines OR dispatched a triage action (merge a
  // ready PR, close a done/stale issue) counts as productive. A run that
  // re-touches files but moves zero lines and dispatched nothing is unproductive
  // churn, not real work (see runWasProductive / runChangedLines).
  const fruitful = window.filter(runWasProductive).length;
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

export interface UnfruitfulAgentInput {
  id: string;
  name: string;
  project: string;
  role: AgentRole;
  kind: 'user' | 'system';
  enabled: boolean;
}

export interface UnfruitfulAgentDisableDeps {
  enabled: boolean;
  threshold: number;
  rateThreshold: number;
  listJobs: () => JobData[];
  isAgentJobKind: (kind: unknown) => boolean;
  getJobKind?: (kind: unknown) => string;
  listAgents: () => UnfruitfulAgentInput[];
  isProjectActive?: (project: string) => boolean;
  disableAgent: (agent: UnfruitfulAgentInput) => Promise<boolean>;
  recommend: (input: {
    project: string;
    agentId: string;
    agentName: string;
    title: string;
    detail: string;
    payload?: Record<string, unknown>;
    status?: 'open' | 'dismissed' | 'applied' | 'resolved';
  }) => Promise<unknown>;
  log?: (msg: string) => void;
}

export interface UnfruitfulAgentDisableResult {
  disabled: string[];
}

function jobKindMatchesAgent(
  run: JobData,
  agent: Pick<UnfruitfulAgentInput, 'id' | 'name'>,
  getJobKind: (kind: unknown) => string,
): boolean {
  const kind = getJobKind(run.kind);
  if (kind === `agent:${agent.name}`) return true;
  const meta = parseAgentMeta(run.contextMeta)?.agent as { id?: string; name?: string } | undefined;
  return meta?.id === agent.id || meta?.name === agent.name;
}

function recentScheduledRunsForAgent(
  allJobs: JobData[],
  agent: UnfruitfulAgentInput,
  deps: Pick<UnfruitfulAgentDisableDeps, 'isAgentJobKind' | 'getJobKind'>,
  limit: number,
): JobData[] {
  const getJobKind = deps.getJobKind ?? ((kind: unknown) => (typeof kind === 'string' ? kind : String(kind ?? '')));
  const scheduledForAgent = allJobs
    .filter((j) => j.finishedAt != null && deps.isAgentJobKind(j.kind) && isScheduledAgentRun(j))
    .filter((j) => jobKindMatchesAgent(j, agent, getJobKind))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  const sameProject = scheduledForAgent.filter((j) => j.project === agent.project);
  return (sameProject.length > 0 ? sameProject : scheduledForAgent).slice(0, limit);
}

/**
 * Scan enabled user producer agents and disable only the agent whose own recent
 * scheduled runs are caught-up/unfruitful. This intentionally does not pause
 * the containing project: healthy sibling agents, manual runs, issue/PR work
 * and release automation must keep running.
 */
export async function autoDisableUnfruitfulAgents(
  deps: UnfruitfulAgentDisableDeps,
): Promise<UnfruitfulAgentDisableResult> {
  const disabled: string[] = [];
  if (!deps.enabled) return { disabled };

  const requiredRuns = effectiveThreshold(deps.threshold);
  const sample = unfruitfulRateSample(deps.threshold);
  const fetchLimit = Math.max(requiredRuns, sample) * 4;
  const jobs = deps.listJobs();

  for (const agent of deps.listAgents()) {
    if (!agent.enabled) continue;
    if (agent.kind === 'system') continue;
    if (agent.role !== 'producer') continue;
    if (deps.isProjectActive && !deps.isProjectActive(agent.project)) continue;

    const runs = recentScheduledRunsForAgent(jobs, agent, deps, fetchLimit);
    if (runs.some(runIsExternallyGated)) continue;

    const caughtUp = isProjectCaughtUpUnfruitful(runs, deps.threshold);
    const lowRate = !caughtUp && isProjectPersistentlyUnfruitful(runs, sample, deps.rateThreshold);
    if (!caughtUp && !lowRate) continue;

    const ok = await deps.disableAgent(agent);
    if (!ok) continue;
    disabled.push(agent.name);

    const window = runs.slice(0, sample);
    const ratePct = sample > 0 && window.length >= sample
      ? Math.round((window.filter(runWasProductive).length / sample) * 100)
      : 0;
    const title = caughtUp
      ? `${agent.name} auto-disabled - caught up (nothing to do)`
      : `${agent.name} auto-disabled - persistently unfruitful (${ratePct}% of runs produce changes)`;
    const detail = caughtUp
      ? `The last ${requiredRuns} scheduled runs for ${agent.name} produced no changes and at least one ` +
        `reported nothing to do. TamTam disabled only this agent to stop it churning for no value; ` +
        `the project and sibling agents remain active. Re-enable the agent when there is new work.`
      : `Only ${ratePct}% of the last ${sample} scheduled runs for ${agent.name} produced value - below the ` +
        `${Math.round(deps.rateThreshold * 100)}% auto-disable floor. TamTam disabled only this agent; ` +
        `re-enable it after adjusting its prompt, cadence, or backlog source.`;

    try {
      // The agent is already disabled above, so this recommendation records a
      // COMPLETED action rather than a pending decision. Create it `resolved`
      // (mirrors the orchestrator_boost "already complete at creation" pattern)
      // so it archives to History instead of sitting in the "Needs your
      // decision" queue where it could never auto-clear (its cron is
      // uninstalled, so no future run can resolve it). `enabled:false` in the
      // payload stops the Fix menu from offering Run/Disable on an agent that
      // is already off (see lib/attention/recommendation-actions.ts).
      await deps.recommend({
        project: agent.project,
        agentId: agent.id,
        agentName: agent.name,
        title,
        detail,
        payload: { enabled: false },
        status: 'resolved',
      });
    } catch (e) {
      deps.log?.(`[unfruitful-pause] recommendation failed for ${agent.project}/${agent.name}: ${e instanceof Error ? e.message : String(e)}`);
    }

    deps.log?.(`[unfruitful-pause] auto-disabled ${agent.project}/${agent.name} (${caughtUp ? `${requiredRuns} caught-up/no-diff runs` : `low fruitful rate ${ratePct}% over ${sample} runs`})`);
  }

  return { disabled };
}

/**
 * Runtime entry: wire `autoDisableUnfruitfulAgents` with real deps. Lazy
 * imports keep the pure functions above (and their tests) free of the DB/job
 * layer. Safe to call from a background sweep - no-ops when the setting is off.
 */
export async function runUnfruitfulPauseSweep(): Promise<UnfruitfulAgentDisableResult> {
  const { getSettings } = await import('@/lib/shared/config');
  const s = getSettings();
  if (!s.auto_pause_unfruitful_enabled) return { disabled: [] };

  const [
    { listJobs },
    { isAgentJobKind },
    { listEnabledProjects },
    { upsertRecommendation },
    { getAllAgentsCachedAsync, clearAgentsCache },
    { parseAgentRole },
    { db, schema },
    { eq },
    { uninstallAgentSchedule },
  ] =
    await Promise.all([
      import('@/lib/jobs/job-storage'),
      import('@/lib/jobs/kinds'),
      import('@/lib/shared/enabled-projects'),
      import('@/lib/recommendations/recommendations'),
      import('@/lib/agents/agents-cache'),
      import('@/lib/agents/roles'),
      import('@/lib/db'),
      import('drizzle-orm'),
      import('@/lib/scheduling/agent-scheduler'),
    ]);

  const activeProjects = new Set(
    listEnabledProjects()
      .filter((p) => !p.paused)
      .map((p) => p.name),
  );
  const agents = await getAllAgentsCachedAsync();

  return autoDisableUnfruitfulAgents({
    enabled: s.auto_pause_unfruitful_enabled,
    threshold: s.auto_pause_unfruitful_runs,
    rateThreshold: s.auto_pause_unfruitful_rate,
    listJobs,
    isAgentJobKind,
    getJobKind: (kind) => (typeof kind === 'string' ? kind : String(kind ?? '')),
    listAgents: () => agents.map((a) => ({
      id: a.id,
      name: a.name,
      project: a.project,
      role: parseAgentRole(a.role),
      kind: a.kind === 'system' ? 'system' : 'user',
      enabled: !!a.enabled,
    })),
    isProjectActive: (project) => activeProjects.has(project),
    disableAgent: async (agent) => {
      await db
        .update(schema.agents)
        .set({ enabled: false, updatedAt: Date.now() / 1000 })
        .where(eq(schema.agents.id, agent.id))
        .execute();
      clearAgentsCache();
      try {
        await uninstallAgentSchedule(agent.id, agent.project, agent.name);
      } catch (e) {
        console.error(`[unfruitful-pause] failed to uninstall schedule for ${agent.project}/${agent.name}:`, e);
      }
      return true;
    },
    recommend: (input) =>
      upsertRecommendation({
        project: input.project,
        sourceKind: 'orchestrator',
        agentId: input.agentId,
        agentName: input.agentName,
        type: 'agent_unfruitful',
        title: input.title,
        detail: input.detail,
        payload: input.payload ?? null,
        status: input.status ?? 'open',
      }),
    log: (m) => console.log(m),
  });
}
