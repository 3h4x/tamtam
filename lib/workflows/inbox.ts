import { fetchProjectData } from '@/lib/shared/project-data';
import { listJobs } from '@/lib/jobs/storage';
import { getVerdict } from '@/lib/jobs/verdict';
import { listAutomationQueue, type AutomationQueueItem } from '@/lib/workflows/automation-queue';
import { db, schema } from '@/lib/db';
import type { Task } from '@/lib/shared/types';

// The inbox is a cross-project triage feed: one prioritized row per actionable
// signal so the operator can see the next highest-leverage move across every
// tracked repo without clicking into each project. All signals are derived from
// state we already hold locally (project-data cache, in-memory jobs, automation
// queue, the gh issues cache) — no new background work and no live GitHub calls.

export type InboxSignalType =
  | 'ci_red'
  | 'review_needs_decision'
  | 'pr_ready_to_merge'
  | 'stale_changes'
  | 'fix_loop_exhausted'
  | 'orphan_release';

export type InboxSeverity = 'red' | 'yellow' | 'green';

export type InboxActionKind =
  | 'fix-ci'
  | 'release'
  | 'review'
  | 'merge'
  | 'retry-automation'
  | 'open-terminal';

export interface InboxAction {
  kind: InboxActionKind;
  label: string;
  /** Only set for the `merge` action. */
  prNumber?: number;
}

export interface InboxSignal {
  /** Stable per (type, project) so the client can key rows without churn. */
  id: string;
  type: InboxSignalType;
  severity: InboxSeverity;
  project: string;
  title: string;
  detail: string | null;
  /** Secondary "open project" navigation target. */
  href: string;
  /** Optional external link (e.g. failed CI run URL). */
  externalUrl: string | null;
  /** Age of the underlying signal in seconds, when known. */
  ageSeconds: number | null;
  action: InboxAction;
}

export interface InboxCounts {
  red: number;
  yellow: number;
  green: number;
  total: number;
}

// Flattened job projection the pure derivation works over — decouples the
// signal logic from JobData so it can be unit-tested without the jobs cache.
export interface InboxJob {
  project: string;
  kind: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  verdict: string | null;
  releaseStopReason: string | null;
}

export interface InboxOpenPr {
  number: number;
  ciGreen: boolean;
  reviewDecision: string | null;
}

export interface InboxInput {
  tasks: Task[];
  jobs: InboxJob[];
  automationQueue: AutomationQueueItem[];
  openPrByProject: Record<string, InboxOpenPr | undefined>;
  nowSeconds: number;
}

// Kinds that mean a pipeline is actively working the project. When one is
// in-flight we suppress the "needs a decision" signals for that project — the
// pipeline is already handling it and surfacing a button would race it.
const ACTIVE_JOB_KINDS = new Set(['release', 'fix', 'review', 'commit', 'push', 'test', 'mark-dod']);

const SEVERITY_RANK: Record<InboxSeverity, number> = { red: 0, yellow: 1, green: 2 };

function latestJob(jobs: InboxJob[], project: string, kind: string): InboxJob | null {
  let best: InboxJob | null = null;
  for (const j of jobs) {
    if (j.project !== project || j.kind !== kind) continue;
    if (!best || j.startedAt > best.startedAt) best = j;
  }
  return best;
}

function isPipelineActive(jobs: InboxJob[], project: string): boolean {
  return jobs.some((j) => j.project === project && j.finishedAt === null && ACTIVE_JOB_KINDS.has(j.kind));
}

function projectHref(project: string): string {
  return `/project/${encodeURIComponent(project)}`;
}

/**
 * Pure signal derivation. Given the current cross-project state, return one
 * row per actionable signal, sorted red → yellow → green and, within a
 * severity, oldest-first (most urgent). Exported for unit testing.
 */
export function deriveInboxSignals(input: InboxInput): InboxSignal[] {
  const { tasks, jobs, automationQueue, openPrByProject, nowSeconds } = input;
  const signals: InboxSignal[] = [];

  for (const task of tasks) {
    const project = task.project;
    const active = isPipelineActive(jobs, project);
    const review = latestJob(jobs, project, 'review');
    const reviewFinished = review && review.finishedAt !== null ? review : null;
    const verdict = reviewFinished?.verdict ?? null;

    // 1. CI red on the default branch → start a CI fix.
    if (task.ci === 'failure' && !active) {
      signals.push({
        id: `ci_red:${project}`,
        type: 'ci_red',
        severity: 'red',
        project,
        title: 'CI failing on default branch',
        detail: task.release_tag ? `Latest release ${task.release_tag}` : null,
        href: projectHref(project),
        externalUrl: task.ci_failed_url,
        ageSeconds: null,
        action: { kind: 'fix-ci', label: 'Start fix-ci' },
      });
    }

    // 2. Review returned a non-shipping verdict and nothing has picked it up.
    if (reviewFinished && (verdict === 'NEEDS ATTENTION' || verdict === 'DO NOT SHIP')) {
      const chained = jobs.some(
        (j) =>
          j.project === project &&
          (j.kind === 'fix' || j.kind === 'commit' || j.kind === 'push') &&
          j.startedAt > reviewFinished.startedAt,
      );
      if (!chained && !active) {
        signals.push({
          id: `review_needs_decision:${project}`,
          type: 'review_needs_decision',
          severity: verdict === 'DO NOT SHIP' ? 'red' : 'yellow',
          project,
          title: `Review verdict: ${verdict}`,
          detail: 'Last review needs a decision — no fix has chained',
          href: projectHref(project),
          externalUrl: null,
          ageSeconds: reviewFinished.finishedAt != null ? Math.max(0, Math.floor(nowSeconds - reviewFinished.finishedAt)) : null,
          action: { kind: 'release', label: 'Start fix' },
        });
      }
    }

    // 3. Release aborted after exhausting a fix loop / hitting an iteration cap.
    const release = latestJob(jobs, project, 'release');
    if (release && release.finishedAt !== null && release.exitCode !== 0 && release.releaseStopReason && !active) {
      signals.push({
        id: `fix_loop_exhausted:${project}`,
        type: 'fix_loop_exhausted',
        severity: 'red',
        project,
        title: 'Release stopped — fix loop exhausted',
        detail: release.releaseStopReason,
        href: `${projectHref(project)}/terminal`,
        externalUrl: null,
        ageSeconds: Math.max(0, Math.floor(nowSeconds - release.finishedAt)),
        action: { kind: 'open-terminal', label: 'Open Terminal' },
      });
    }

    // 4. Uncommitted changes sitting on disk, not yet reviewed.
    if (task.changes > 0 && task.reviewed === false && !active) {
      signals.push({
        id: `stale_changes:${project}`,
        type: 'stale_changes',
        severity: 'yellow',
        project,
        title: `${task.changes} uncommitted change${task.changes === 1 ? '' : 's'}`,
        detail: 'Working tree is dirty and unreviewed',
        href: `${projectHref(project)}/changes`,
        externalUrl: null,
        ageSeconds: null,
        action: { kind: 'review', label: 'Start review' },
      });
    }

    // 5. Open PR with green CI and a TamTam LGTM (or an upstream approval when
    //    review is disabled) → one-click merge.
    const pr = openPrByProject[project];
    if (pr && pr.ciGreen && task.ci !== 'failure') {
      const lgtm = verdict === 'LGTM';
      const upstreamApproved = !reviewFinished && pr.reviewDecision === 'APPROVED';
      if (lgtm || upstreamApproved) {
        signals.push({
          id: `pr_ready_to_merge:${project}`,
          type: 'pr_ready_to_merge',
          severity: 'green',
          project,
          title: `PR #${pr.number} ready to merge`,
          detail: lgtm ? 'Green CI + review LGTM' : 'Green CI + approved',
          href: `${projectHref(project)}/issues`,
          externalUrl: null,
          ageSeconds: null,
          action: { kind: 'merge', label: 'Merge', prNumber: pr.number },
        });
      }
    }
  }

  // 6. Aborted / orphan releases and other stuck automation-queue entries.
  //    One row per project (keep the most severe).
  const seenAutomation = new Set<string>();
  for (const item of automationQueue) {
    if (seenAutomation.has(item.project)) continue;
    seenAutomation.add(item.project);
    signals.push({
      id: `orphan_release:${item.project}`,
      type: 'orphan_release',
      severity: item.code === 'pipeline_lock' ? 'red' : 'yellow',
      project: item.project,
      title: item.label,
      detail: item.reason,
      href: projectHref(item.project),
      externalUrl: null,
      ageSeconds: item.queuedAt != null ? Math.max(0, Math.floor(nowSeconds - item.queuedAt)) : null,
      action: { kind: 'retry-automation', label: 'Retry' },
    });
  }

  signals.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    // Oldest first within a severity; unknown age sorts last.
    const ageA = a.ageSeconds ?? -1;
    const ageB = b.ageSeconds ?? -1;
    return ageB - ageA || a.project.localeCompare(b.project);
  });

  return signals;
}

export function countInboxSignals(signals: InboxSignal[]): InboxCounts {
  const counts: InboxCounts = { red: 0, yellow: 0, green: 0, total: signals.length };
  for (const s of signals) counts[s.severity] += 1;
  return counts;
}

function safeReleaseStopReason(contextMeta: string | null | undefined): string | null {
  if (!contextMeta) return null;
  try {
    const parsed = JSON.parse(contextMeta) as { releaseStopReason?: unknown };
    return typeof parsed.releaseStopReason === 'string' && parsed.releaseStopReason ? parsed.releaseStopReason : null;
  } catch {
    return null;
  }
}

interface CachedPr {
  number?: number;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  statusCheckRollup?: Array<{ conclusion?: string | null }> | null;
}

function rollupIsGreen(rollup: CachedPr['statusCheckRollup'], fallbackCi: Task['ci']): boolean {
  if (Array.isArray(rollup) && rollup.length > 0) {
    return rollup.every((c) => (c.conclusion ?? '').toUpperCase() === 'SUCCESS');
  }
  // No rollup recorded — defer to the project-data CI signal.
  return fallbackCi === 'success';
}

// Read the cached open PRs (from the gh issues cache) for every project in one
// query. Returns the first open, non-draft PR per project so the merge signal
// can carry a PR number. Fails open (empty map) if the cache table is absent.
async function loadOpenPrs(tasks: Task[]): Promise<Record<string, InboxOpenPr | undefined>> {
  const ciByProject: Record<string, Task['ci']> = {};
  for (const t of tasks) ciByProject[t.project] = t.ci;
  const result: Record<string, InboxOpenPr | undefined> = {};
  try {
    const rows = await db.select().from(schema.ghIssuesCache);
    for (const row of rows) {
      let prs: CachedPr[];
      try {
        prs = JSON.parse(row.prs) as CachedPr[];
      } catch {
        continue;
      }
      const open = prs.find(
        (p) => typeof p.number === 'number' && (p.state ?? '').toUpperCase() === 'OPEN' && !p.isDraft,
      );
      if (!open || typeof open.number !== 'number') continue;
      result[row.project] = {
        number: open.number,
        ciGreen: rollupIsGreen(open.statusCheckRollup, ciByProject[row.project] ?? null),
        reviewDecision: open.reviewDecision ?? null,
      };
    }
  } catch {
    return {};
  }
  return result;
}

/**
 * Gather the current cross-project state and derive the inbox feed. This is the
 * single entry point the `/api/inbox` route calls.
 */
export async function listInboxSignals(): Promise<{ signals: InboxSignal[]; counts: InboxCounts }> {
  const [{ projects }, automationQueue] = await Promise.all([
    fetchProjectData(),
    listAutomationQueue().catch(() => [] as AutomationQueueItem[]),
  ]);
  const tasks: Task[] = Object.values(projects).flat();

  const jobs: InboxJob[] = listJobs().map((j) => ({
    project: j.project,
    kind: j.kind,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    exitCode: j.exitCode,
    verdict: j.kind === 'review' && j.finishedAt !== null ? getVerdict(j) : null,
    releaseStopReason: j.kind === 'release' ? safeReleaseStopReason(j.contextMeta) : null,
  }));

  const openPrByProject = await loadOpenPrs(tasks);

  const signals = deriveInboxSignals({
    tasks,
    jobs,
    automationQueue,
    openPrByProject,
    nowSeconds: Date.now() / 1000,
  });
  return { signals, counts: countInboxSignals(signals) };
}
