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
  | 'pr_needs_manual_merge'
  | 'stale_changes'
  | 'fix_loop_exhausted'
  | 'orphan_release'
  | 'project_paused';

export type InboxSeverity = 'red' | 'yellow' | 'green';

export type InboxActionKind =
  | 'fix-ci'
  | 'release'
  | 'review'
  | 'merge'
  | 'retry-automation'
  | 'open-terminal'
  | 'resume';

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
  /** For pr-wait jobs: the terminal reason (merged / risky_diff /
   *  merge_permanent / …). Null for every other kind. */
  prWaitReason: string | null;
  /** For pr-wait jobs: the PR number it was waiting on. Null otherwise. */
  prNumber: number | null;
  /** For a `risky_diff` pr-wait: the specific high-risk files the diff touched,
   *  so the HITL can name WHY the auto-merge was refused. Null otherwise. */
  riskyFiles: string[] | null;
  /** The release this job belongs to, when release-linked. Lets the
   *  manual-merge HITL find the DoD verification from the same release's
   *  mark-dod job. Null for standalone jobs. */
  releaseId: string | null;
  /** For mark-dod jobs: acceptance-criteria verified / total and the issue (or
   *  PR) number the DoD was checked against, so a deferred-merge HITL can show
   *  the operator what claude verified before they decide. Null otherwise. */
  dodVerified: number | null;
  dodTotal: number | null;
  dodIssueNumber: number | null;
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
  /** All open (non-draft) PR numbers per project — used to confirm a
   *  human-deferred PR is still open before surfacing a manual-merge signal. */
  openPrNumbersByProject: Record<string, number[]>;
  /** Reason a project was AUTO-paused (circuit-breaker, push-hook, soak), keyed
   *  by project. Presence marks a system pause that must surface as a HITL;
   *  absence means either not paused or a deliberate manual pause (no nag). */
  pausedReasonByProject: Record<string, string>;
  nowSeconds: number;
}

// pr-wait terminal reasons that do NOT need a human: the merge landed, the PR
// was closed/abandoned, or a CI failure self-heals via a re-dispatched fix-ci.
// EVERYTHING ELSE that finishes a pr-wait non-zero — a merge conflict, a failed
// branch switch, a mergeability timeout, the high-risk-diff guard, a permanent
// merge block, or an unrecorded/blank reason — leaves a stranded PR a human must
// act on, so it MUST surface as a HITL signal instead of stopping silently.
const NO_HITL_REASONS = new Set(['merged', 'pr_closed', 'checks_failed']);
const MERGE_REASON_DETAIL: Record<string, string> = {
  risky_diff: 'Auto-merge deferred — PR diff touches high-risk execution files. Needs a human merge decision.',
  merge_permanent: 'Auto-merge blocked — manual merge required.',
  conflict: 'Auto-merge blocked — the PR has merge conflicts with the base branch. Needs a manual rebase/resolve or merge.',
  switch_failed: 'Auto-merge could not complete — the pipeline failed to switch branches. Needs a human check.',
  timeout: 'Auto-merge timed out waiting for the PR to become mergeable. Needs a human check.',
};

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

// Find the DoD (mark-dod) verification from the same release a deferred pr-wait
// belongs to, so the manual-merge HITL can show what claude verified against the
// issue before the operator decides to merge. Newest per release wins.
function latestDodForRelease(jobs: InboxJob[], project: string, releaseId: string | null): InboxJob | null {
  if (!releaseId) return null;
  let best: InboxJob | null = null;
  for (const j of jobs) {
    if (j.project !== project || j.kind !== 'mark-dod' || j.releaseId !== releaseId) continue;
    if (!best || j.startedAt > best.startedAt) best = j;
  }
  return best;
}

// Render the "what claude verified" suffix for a manual-merge HITL from the
// release's DoD job: the X/N criteria count and the issue it was checked
// against. Empty when there are no acceptance criteria (nothing to show).
function dodDetailSuffix(dod: InboxJob | null): string {
  if (!dod) return '';
  if (dod.dodTotal != null && dod.dodTotal > 0) {
    const issueRef = dod.dodIssueNumber != null ? ` on issue #${dod.dodIssueNumber}` : '';
    return ` DoD: ${dod.dodVerified ?? 0}/${dod.dodTotal} acceptance criteria verified${issueRef}.`;
  }
  if (dod.dodIssueNumber != null) return ` Linked issue #${dod.dodIssueNumber}.`;
  return '';
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
  const { tasks, jobs, automationQueue, openPrByProject, openPrNumbersByProject, pausedReasonByProject, nowSeconds } = input;
  const signals: InboxSignal[] = [];

  for (const task of tasks) {
    const project = task.project;
    const active = isPipelineActive(jobs, project);
    const review = latestJob(jobs, project, 'review');
    const reviewFinished = review && review.finishedAt !== null ? review : null;
    const verdict = reviewFinished?.verdict ?? null;

    // 0. AUTO-paused project (circuit-breaker / push-hook / soak). A system pause
    //    halts ALL automation for the project, so it MUST surface as a HITL —
    //    never a silent pause (operator rule, mirrors merge-or-HITL in CLAUDE.md).
    //    A deliberate MANUAL pause records no reason and does NOT nag here.
    const pausedReason = pausedReasonByProject[project];
    if (task.paused && pausedReason) {
      signals.push({
        id: `project_paused:${project}`,
        type: 'project_paused',
        severity: 'red',
        project,
        title: 'Project auto-paused — automation halted',
        detail: pausedReason,
        href: projectHref(project),
        externalUrl: null,
        ageSeconds: null,
        action: { kind: 'resume', label: 'Resume' },
      });
    }

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

    // 1b. pr-wait deferred auto-merge to a human (HITL). A `risky_diff` /
    //     `merge_permanent` defer is PERMANENT — the pipeline will never
    //     resolve it on its own — so this is NOT gated on `!active`: the
    //     project may (and for a busy repo, always does) have another pipeline
    //     running, but the deferred PR still needs a human merge decision now.
    //     Open-PR check is lenient: when the gh issues cache has entries for
    //     the project we require membership (self-clears once merged/closed);
    //     when the cache is empty/absent (markDone wipes it on every finalize)
    //     we still surface it rather than hide a real HITL decision.
    // Group pr-wait jobs by PR and keep the latest per PR. A busy repo fires a
    // fresh release (and pr-wait) every cycle, so keying off the project's
    // single most-recent pr-wait would let a newer pr-wait for a *different*
    // PR shadow an older PR's still-unresolved HITL defer. One signal per PR.
    const latestPrWaitByPr = new Map<number, InboxJob>();
    for (const j of jobs) {
      if (j.project !== project || j.kind !== 'pr-wait' || j.prNumber == null) continue;
      const cur = latestPrWaitByPr.get(j.prNumber);
      if (!cur || j.startedAt > cur.startedAt) latestPrWaitByPr.set(j.prNumber, j);
    }
    const openNums = openPrNumbersByProject[project];
    for (const [prNumber, prWait] of latestPrWaitByPr) {
      if (
        prWait.finishedAt === null ||
        (prWait.exitCode ?? 0) === 0 ||
        (prWait.prWaitReason != null && NO_HITL_REASONS.has(prWait.prWaitReason))
      ) {
        continue;
      }
      // Lenient open check: require membership only when the cache lists PRs;
      // an empty/absent cache (markDone wipes it per finalize) still surfaces.
      const stillOpen = !openNums || openNums.length === 0 || openNums.includes(prNumber);
      if (!stillOpen) continue;
      // Surface the release's DoD verification so the operator can see the issue
      // and what claude verified against it BEFORE deciding to merge a risky PR
      // — the pre-pr-wait mark-dod already ran, so this is "shown before merge".
      const dodSuffix = dodDetailSuffix(latestDodForRelease(jobs, project, prWait.releaseId));
      signals.push({
        id: `pr_needs_manual_merge:${project}:${prNumber}`,
        type: 'pr_needs_manual_merge',
        severity: 'yellow',
        project,
        title: `PR #${prNumber} needs manual merge`,
        detail: ((prWait.prWaitReason ? MERGE_REASON_DETAIL[prWait.prWaitReason] : undefined)
          ?? 'Auto-merge did not complete — needs a human merge/close decision.')
          + (prWait.prWaitReason === 'risky_diff' && prWait.riskyFiles && prWait.riskyFiles.length > 0
            ? ` High-risk files: ${prWait.riskyFiles.join(', ')}.`
            : '')
          + dodSuffix,
        href: `${projectHref(project)}/issues`,
        externalUrl: task.github ? `${task.github}/pull/${prNumber}` : null,
        ageSeconds: null,
        action: { kind: 'merge', label: 'Merge', prNumber },
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

    // 3. Catch-all for the merge-or-HITL invariant: a release that finished
    //    non-zero is TERMINAL and must surface — never a silent stop. Fires for
    //    ANY non-zero release, including a bare abort that stamped no
    //    releaseStopReason (wall-clock timeout, 'unknown' terminal, or a finalize
    //    path that forgot to stamp one). Suppressed when it is already surfaced
    //    as a manual-merge, a newer pipeline job started after it finished
    //    (something is actively re-driving it — let that run), or the release's
    //    PR actually shipped via a (manual) merge after the release job exited.
    const release = latestJob(jobs, project, 'release');
    if (release && release.finishedAt !== null && release.exitCode !== 0) {
      const coveredByMerge = signals.some(
        (s) => s.project === project && s.type === 'pr_needs_manual_merge',
      );
      const reDriving = jobs.some(
        (j) =>
          j.project === project &&
          j.finishedAt === null &&
          ACTIVE_JOB_KINDS.has(j.kind) &&
          j.startedAt >= (release.finishedAt as number),
      );
      // The release's PR can ship via a merge that lands AFTER the release job
      // itself exited non-zero — a `risky_diff`/`merge_permanent` defer that the
      // operator then merges from the inbox, or a pr-wait that merged but exited
      // non-zero on a later step. A completed merge is the "merged" arm of the
      // merge-or-HITL invariant (work shipped), so it is no longer a silent
      // stop: don't nag with a stale "Release stopped — no merge". Only credit
      // a merge from this release cycle onward (started at/after the failed
      // release) so an unrelated older merge can't mask a genuinely failed run.
      const shippedByMerge = jobs.some(
        (j) =>
          j.project === project &&
          j.kind === 'pr-wait' &&
          j.prWaitReason === 'merged' &&
          j.startedAt >= release.startedAt,
      );
      if (!coveredByMerge && !reDriving && !shippedByMerge) {
        signals.push({
          id: `fix_loop_exhausted:${project}`,
          type: 'fix_loop_exhausted',
          severity: 'red',
          project,
          title: release.releaseStopReason ? 'Release stopped — fix loop exhausted' : 'Release stopped',
          detail:
            release.releaseStopReason ??
            `Release ended without shipping (exit ${release.exitCode}) — no merge and no other signal. Needs a human check.`,
          href: `${projectHref(project)}/terminal`,
          externalUrl: null,
          ageSeconds: Math.max(0, Math.floor(nowSeconds - release.finishedAt)),
          action: { kind: 'open-terminal', label: 'Open Terminal' },
        });
      }
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

// Read a pr-wait job's persisted terminal reason + PR number from contextMeta.
// finalizePrWaitStep stamps `prWaitReason` alongside the {prNumber, prRepo,
// prUrl} the phase was dispatched with.
function safePrWaitInfo(contextMeta: string | null | undefined): { reason: string | null; prNumber: number | null; riskyFiles: string[] | null } {
  if (!contextMeta) return { reason: null, prNumber: null, riskyFiles: null };
  try {
    const parsed = JSON.parse(contextMeta) as { prWaitReason?: unknown; prNumber?: unknown; riskyFiles?: unknown };
    const riskyFiles = Array.isArray(parsed.riskyFiles)
      ? parsed.riskyFiles.filter((f): f is string => typeof f === 'string')
      : null;
    return {
      reason: typeof parsed.prWaitReason === 'string' && parsed.prWaitReason ? parsed.prWaitReason : null,
      prNumber: typeof parsed.prNumber === 'number' ? parsed.prNumber : null,
      riskyFiles: riskyFiles && riskyFiles.length > 0 ? riskyFiles : null,
    };
  } catch {
    return { reason: null, prNumber: null, riskyFiles: null };
  }
}

// Read a mark-dod job's persisted DoD result from contextMeta. buildMarkDodContextMeta
// stamps { verified, total, sourceNumber } (verified/total are null until the
// verify completes). Only numeric values survive so a partial run reads as null.
function safeMarkDodInfo(contextMeta: string | null | undefined): { verified: number | null; total: number | null; issueNumber: number | null } {
  if (!contextMeta) return { verified: null, total: null, issueNumber: null };
  try {
    const parsed = JSON.parse(contextMeta) as { verified?: unknown; total?: unknown; sourceNumber?: unknown };
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    return { verified: num(parsed.verified), total: num(parsed.total), issueNumber: num(parsed.sourceNumber) };
  } catch {
    return { verified: null, total: null, issueNumber: null };
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
// query. Returns the first open, non-draft PR per project (so the merge signal
// can carry a PR number) plus the full set of open non-draft PR numbers per
// project (so the manual-merge signal can confirm a specific PR is still open).
// Fails open (empty maps) if the cache table is absent.
async function loadOpenPrs(
  tasks: Task[],
): Promise<{ byProject: Record<string, InboxOpenPr | undefined>; numbersByProject: Record<string, number[]> }> {
  const ciByProject: Record<string, Task['ci']> = {};
  for (const t of tasks) ciByProject[t.project] = t.ci;
  const byProject: Record<string, InboxOpenPr | undefined> = {};
  const numbersByProject: Record<string, number[]> = {};
  try {
    const rows = await db.select().from(schema.ghIssuesCache);
    for (const row of rows) {
      let prs: CachedPr[];
      try {
        prs = JSON.parse(row.prs) as CachedPr[];
      } catch {
        continue;
      }
      const openPrs = prs.filter(
        (p) => typeof p.number === 'number' && (p.state ?? '').toUpperCase() === 'OPEN' && !p.isDraft,
      );
      numbersByProject[row.project] = openPrs.map((p) => p.number as number);
      const open = openPrs[0];
      if (!open || typeof open.number !== 'number') continue;
      byProject[row.project] = {
        number: open.number,
        ciGreen: rollupIsGreen(open.statusCheckRollup, ciByProject[row.project] ?? null),
        reviewDecision: open.reviewDecision ?? null,
      };
    }
  } catch {
    return { byProject: {}, numbersByProject: {} };
  }
  return { byProject, numbersByProject };
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

  const jobs: InboxJob[] = listJobs().map((j) => {
    const prWait = j.kind === 'pr-wait' ? safePrWaitInfo(j.contextMeta) : null;
    const dod = j.kind === 'mark-dod' ? safeMarkDodInfo(j.contextMeta) : null;
    return {
      project: j.project,
      kind: j.kind,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      exitCode: j.exitCode,
      verdict: j.kind === 'review' && j.finishedAt !== null ? getVerdict(j) : null,
      releaseStopReason: j.kind === 'release' ? safeReleaseStopReason(j.contextMeta) : null,
      prWaitReason: prWait?.reason ?? null,
      prNumber: prWait?.prNumber ?? null,
      riskyFiles: prWait?.riskyFiles ?? null,
      releaseId: j.releaseId ?? null,
      dodVerified: dod?.verified ?? null,
      dodTotal: dod?.total ?? null,
      dodIssueNumber: dod?.issueNumber ?? null,
    };
  });

  const { byProject: openPrByProject, numbersByProject: openPrNumbersByProject } = await loadOpenPrs(tasks);
  const { listPauseReasons } = await import('@/lib/pipeline/pause-project');
  const pausedReasonByProject = await listPauseReasons().catch(() => ({}));

  const signals = deriveInboxSignals({
    tasks,
    jobs,
    automationQueue,
    openPrByProject,
    openPrNumbersByProject,
    pausedReasonByProject,
    nowSeconds: Date.now() / 1000,
  });
  return { signals, counts: countInboxSignals(signals) };
}
