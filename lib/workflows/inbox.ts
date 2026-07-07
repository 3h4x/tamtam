import { fetchProjectData, resolveProjectPath } from '@/lib/shared/project-data';
import { isUserTrusted } from '@/lib/shared/untrusted';
import { listJobs } from '@/lib/jobs/storage';
import { getVerdict } from '@/lib/jobs/verdict';
import { listAutomationQueue, type AutomationQueueItem } from '@/lib/workflows/automation-queue';
import { db, schema } from '@/lib/db';
import { isAgentJobKind } from '@/lib/jobs/kinds';
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes';
import { swrGet, type SwrStore } from '@/lib/shared/swr-cache';
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
  | 'pr_conflicts'
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
  | 'resolve-conflicts'
  | 'retry-automation'
  | 'open-terminal'
  | 'resume';

export interface InboxAction {
  kind: InboxActionKind;
  label: string;
  /** Set for the `merge` and `resolve-conflicts` actions (the PR they target). */
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
  /** GitHub mergeability (MERGEABLE | CONFLICTING | UNKNOWN, uppercased). A
   *  CONFLICTING PR is out of sync with its base branch and must NOT be shown
   *  as "ready to merge" even with green CI + an LGTM. Optional so cache rows /
   *  test fixtures without it read as "unknown" — only an explicit CONFLICTING
   *  suppresses the ready signal. */
  mergeable?: string | null;
  /** The PR author's GitHub login, or null when unknown. */
  authorLogin?: string | null;
  /** Whether the PR author is in the project's safe_users / trusted_github_users.
   *  Resolved at load time (see loadOpenPrs). A one-click "ready to merge" is only
   *  offered for a TRUSTED author: an external PR (dependabot, a public-repo
   *  contributor, an attacker) can have green CI and be paired with an unrelated
   *  project-level LGTM, so surfacing it as ready-to-merge would nudge merging
   *  untrusted code. Defaults to false when omitted — fail closed. */
  authorTrusted?: boolean;
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
  ci_failed: 'Auto-merge blocked — the PR’s CI checks are failing. Fix the failing check(s), then run Review again to merge.',
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

// Any unfinished job that is actively working the project's tree or driving its
// release cycle — a running agent run, a terminal run, a pipeline phase, or the
// post-run fix/merge legs. A superset of ACTIVE_JOB_KINDS (which stays
// pipeline-only for the release-status signals). While one of these is in
// flight the working tree is EXPECTED to be dirty: the run owns those changes
// and commits + pushes them at the end of its release cycle, so a "dirty &
// unreviewed" nag is premature and misleading. Derivation is stateless, so the
// nag reappears on its own once the work settles and changes remain.
const WORKING_JOB_KINDS = new Set([
  ...ACTIVE_JOB_KINDS,
  'run',
  'fix-ci',
  'resolve-conflicts',
  'pr-comment-fix',
  'mark-dod-verify',
  'pr-wait',
]);

function isProjectWorking(jobs: InboxJob[], project: string): boolean {
  return jobs.some(
    (j) =>
      j.project === project &&
      j.finishedAt === null &&
      (WORKING_JOB_KINDS.has(j.kind) || isAgentJobKind(j.kind)),
  );
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
      // NB: when the same project has a pr_needs_manual_merge below, this paused
      // row is suppressed as redundant (merging that PR also resumes the project)
      // — see the dedup pass after the loop. It only stands alone when the pause
      // is NOT already covered by a merge blocker (e.g. paused before pr-wait).
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

    // 1. CI red on the default branch → start a CI fix. This is about the
    //    DEFAULT branch, not any open feature-branch PR. When the operator has an
    //    open PR (i.e. is mid-issue), finishing that PR is the higher-priority
    //    move, so demote this to a non-urgent yellow and say plainly that it is
    //    separate — otherwise a red default-branch CI drowns out the finish-PR
    //    action the operator actually needs.
    if (task.ci === 'failure' && !active) {
      const hasOpenPr = !!openPrByProject[project];
      signals.push({
        id: `ci_red:${project}`,
        type: 'ci_red',
        severity: hasOpenPr ? 'yellow' : 'red',
        project,
        title: 'CI failing on default branch',
        detail: (task.release_tag ? `Latest release ${task.release_tag} — default branch` : 'Default branch')
          + (hasOpenPr ? ', separate from your open PR' : ''),
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
        // Red, not yellow: when you are mid-issue this deferred merge is THE thing
        // blocking the issue from completing — it must read as the blocker and
        // outrank secondary noise (a default-branch ci_red, the redundant pause).
        severity: 'red',
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
        // A merge-conflict terminal can't be resolved by clicking "Merge" (the
        // merge fails), so offer the resolve-conflicts action instead. Every
        // other manual-merge reason (risky_diff, merge_permanent, timeout, …)
        // is a mergeable PR awaiting a human decision → keep the merge action.
        action: prWait.prWaitReason === 'conflict'
          ? { kind: 'resolve-conflicts', label: 'Resolve conflicts', prNumber }
          : { kind: 'merge', label: 'Merge', prNumber },
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
      // The direct-push arm of the merge-or-HITL invariant. A release whose PUSH
      // step exited non-zero (push-fix cap / push blocked / pre-push hook) but
      // whose commits nonetheless reached the remote is no longer stranded: the
      // pre-push hook rejected during the run (often transient), yet the tree is
      // now clean with nothing left unpushed, so the "push … needs recovery"
      // reason is satisfied — there is nothing for a human to push. Direct-push
      // releases never produce a `pr-wait merged` job, so without this they nag
      // forever. Scoped to push stop reasons and gated on the project being
      // genuinely shipped (clean tree AND zero unpushed commits) so a still-
      // stranded release — unpushed commits, a dirty tree, or a non-push stop
      // reason — keeps surfacing. Mirrors `shippedByMerge` for the PR leg.
      const shippedByPush =
        !!release.releaseStopReason &&
        /push/i.test(release.releaseStopReason) &&
        task.changes === 0 &&
        task.unpushed === 0;
      if (!coveredByMerge && !reDriving && !shippedByMerge && !shippedByPush) {
        // A cancelled/interrupted release (exit -2/-3: killed by a restart, the
        // probe sweep, or a manual cancel — isCancelledExitCode) with NO recorded
        // stop reason is not a genuine pipeline failure. The rest of the system
        // treats these codes as non-failures (circuit breaker, push-fix chain,
        // terminal). It must still surface — it didn't ship and nothing else
        // covers it (merge-or-HITL) — but as a lower-urgency "interrupted, re-run"
        // item, NOT a red "fix loop exhausted / needs a human check" failure that
        // would inflate the urgent count. A recorded stop reason is authoritative,
        // so a cancelled code that DID stamp one keeps the red failure treatment;
        // wall-clock/token-cap kills use distinct codes and stay red too.
        const interrupted = isCancelledExitCode(release.exitCode) && !release.releaseStopReason;
        signals.push({
          id: `fix_loop_exhausted:${project}`,
          type: 'fix_loop_exhausted',
          severity: interrupted ? 'yellow' : 'red',
          project,
          title: interrupted
            ? 'Release interrupted — not shipped'
            : release.releaseStopReason
              ? 'Release stopped — fix loop exhausted'
              : 'Release stopped',
          detail: interrupted
            ? `Release was cancelled/interrupted (exit ${release.exitCode}, e.g. by a restart) before shipping — re-run the release to retry.`
            : release.releaseStopReason ??
              `Release ended without shipping (exit ${release.exitCode}) — no merge and no other signal. Needs a human check.`,
          href: `${projectHref(project)}/terminal`,
          externalUrl: null,
          ageSeconds: Math.max(0, Math.floor(nowSeconds - release.finishedAt)),
          action: { kind: 'open-terminal', label: 'Open Terminal' },
        });
      }
    }

    // 4. Uncommitted changes sitting on disk, not yet reviewed. Suppressed while
    //    ANY job is actively working the project (agent/terminal run or pipeline
    //    leg), not just a pipeline phase: a running agent owns those changes and
    //    ships them via its release cycle, so nagging mid-run is premature.
    if (task.changes > 0 && task.reviewed === false && !isProjectWorking(jobs, project)) {
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
    //    review is disabled). "Ready to merge" REQUIRES the PR to actually be
    //    mergeable: a CONFLICTING PR has green CI + an LGTM but is out of sync
    //    with base, so a one-click "Merge" is a lie (the merge fails). When the
    //    PR conflicts, surface a resolve-conflicts HITL instead of a false
    //    ready-to-merge — unless the pr-wait `conflict` terminal already raised
    //    a manual-merge/conflict row for this PR above (one row per PR).
    const pr = openPrByProject[project];
    if (pr && pr.ciGreen && task.ci !== 'failure') {
      const lgtm = verdict === 'LGTM';
      const upstreamApproved = !reviewFinished && pr.reviewDecision === 'APPROVED';
      if (lgtm || upstreamApproved) {
        const conflicting = (pr.mergeable ?? '').toUpperCase() === 'CONFLICTING';
        const reviewDetail = lgtm ? 'Green CI + review LGTM' : 'Green CI + approved';
        if (conflicting) {
          const alreadySurfaced = signals.some(
            (s) =>
              s.project === project &&
              (s.type === 'pr_needs_manual_merge' || s.type === 'pr_conflicts') &&
              s.action.prNumber === pr.number,
          );
          if (!alreadySurfaced) {
            signals.push({
              id: `pr_conflicts:${project}:${pr.number}`,
              type: 'pr_conflicts',
              severity: 'yellow',
              project,
              title: `PR #${pr.number} has merge conflicts`,
              detail: `${reviewDetail}, but the branch conflicts with base. TamTam can auto-resolve only when the branch author is a trusted user; otherwise rebase it onto the base branch, resolve the conflicts, and merge it manually.`,
              href: `${projectHref(project)}/issues`,
              externalUrl: task.github ? `${task.github}/pull/${pr.number}` : null,
              ageSeconds: null,
              action: { kind: 'resolve-conflicts', label: 'Resolve conflicts', prNumber: pr.number },
            });
          }
        } else if (pr.authorTrusted) {
          signals.push({
            id: `pr_ready_to_merge:${project}`,
            type: 'pr_ready_to_merge',
            severity: 'green',
            project,
            title: `PR #${pr.number} ready to merge`,
            detail: reviewDetail,
            href: `${projectHref(project)}/issues`,
            externalUrl: null,
            ageSeconds: null,
            action: { kind: 'merge', label: 'Merge', prNumber: pr.number },
          });
        }
        // else: the representative PR's author is NOT in safe_users /
        // trusted_github_users. Do NOT offer a one-click "ready to merge" — an
        // external PR (e.g. dependabot, a public-repo contributor, or an
        // attacker) can carry green CI and get paired with an unrelated
        // project-level LGTM, so a "Merge" nudge would push untrusted code onto
        // the default branch. A PR that earned a real TamTam LGTM already passed
        // the pr-branch execution gate (trusted authors) to be reviewed at all,
        // so this only suppresses the false-positive. The Issues tab already
        // filters untrusted-author PRs out of its display, and the merge route
        // refuses an untrusted-author merge — all three stay consistent.
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

  // Dedup: a pr_needs_manual_merge is the single finish-the-issue blocker for its
  // project, and merging it also clears any auto-pause (the merge action resumes).
  // So a separate project_paused row for the same project is redundant noise that
  // would only compete with — and, being red, outrank — the actual merge blocker.
  // Drop it, leaving the manual-merge signal to stand alone as the blocker.
  const projectsWithManualMerge = new Set(
    signals.filter((s) => s.type === 'pr_needs_manual_merge').map((s) => s.project),
  );
  const visible = signals.filter(
    (s) => !(s.type === 'project_paused' && projectsWithManualMerge.has(s.project)),
  );

  visible.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    // Oldest first within a severity; unknown age sorts last.
    const ageA = a.ageSeconds ?? -1;
    const ageB = b.ageSeconds ?? -1;
    return ageB - ageA || a.project.localeCompare(b.project);
  });

  return visible;
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
  mergeable?: string | null;
  statusCheckRollup?: Array<{ conclusion?: string | null }> | null;
  author?: { login?: string | null } | null;
}

// Check conclusions that count as PASSING (non-blocking). SUCCESS is an explicit
// pass; SKIPPED (a conditional job that didn't need to run) and NEUTRAL are not
// failures and don't block a merge — GitHub treats a rollup of SUCCESS+SKIPPED
// as mergeable. Anything else — a failing conclusion (FAILURE / TIMED_OUT /
// CANCELLED / ACTION_REQUIRED / …) or a not-yet-concluded (empty) check that is
// still pending — is NOT green. Requiring strict all-SUCCESS wrongly suppressed
// the pr_ready_to_merge / pr_conflicts signal for effectively-green PRs.
const PASSING_CHECK_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

export function rollupIsGreen(rollup: CachedPr['statusCheckRollup'], fallbackCi: Task['ci']): boolean {
  if (Array.isArray(rollup) && rollup.length > 0) {
    return rollup.every((c) => PASSING_CHECK_CONCLUSIONS.has((c.conclusion ?? '').toUpperCase()));
  }
  // No rollup recorded — defer to the project-data CI signal.
  return fallbackCi === 'success';
}

// Choose the single PR the inbox surfaces per project for the ready/conflict
// signals. A project can have many open PRs, but those signals only evaluate ONE
// representative — so it must be the most-ACTIONABLE, not merely the newest. A
// non-green newest PR must NOT shadow an older green one that carries a real
// action (green+conflicting → resolve; green+LGTM → merge). Preference order:
//   1. a green CONFLICTING PR — blocked, needs a human resolve (most urgent);
//   2. any green PR — green + an LGTM/approval becomes ready-to-merge;
//   3. the newest open PR — no actionable signal, but preserves a PR number.
// (The per-PR `pr_needs_manual_merge` path is separate and already handles every
// PR via its pr-wait jobs; this only governs the single ready/conflict slot.)
export function selectRepresentativePr(openPrs: CachedPr[], ciFallback: Task['ci']): CachedPr | undefined {
  if (openPrs.length === 0) return undefined;
  const green = openPrs.filter((p) => rollupIsGreen(p.statusCheckRollup, ciFallback));
  const conflictingGreen = green.find((p) => (p.mergeable ?? '').toUpperCase() === 'CONFLICTING');
  return conflictingGreen ?? green[0] ?? openPrs[0];
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
      const open = selectRepresentativePr(openPrs, ciByProject[row.project] ?? null);
      if (!open || typeof open.number !== 'number') continue;
      // Resolve the PR author's trust here (data layer) so the pure signal
      // derivation stays I/O-free. Fail closed: an unresolvable project path or
      // a missing author login reads as untrusted, so an external PR is never
      // surfaced as one-click ready-to-merge.
      const authorLogin = typeof open.author?.login === 'string' ? open.author.login : null;
      const projPath = resolveProjectPath(row.project);
      const authorTrusted = !!(authorLogin && projPath && isUserTrusted(authorLogin, projPath));
      byProject[row.project] = {
        number: open.number,
        ciGreen: rollupIsGreen(open.statusCheckRollup, ciByProject[row.project] ?? null),
        reviewDecision: open.reviewDecision ?? null,
        mergeable: open.mergeable ?? null,
        authorLogin,
        authorTrusted,
      };
    }
  } catch {
    return { byProject: {}, numbersByProject: {} };
  }
  return { byProject, numbersByProject };
}

type InboxSignalsResult = { signals: InboxSignal[]; counts: InboxCounts };

// SWR cache for the full cross-project inbox derivation. Both `/api/inbox` (the
// nav-badge count that fires on EVERY page) and `/api/attention` (the project
// pages) call this, and on top of the project-data sweep it does its own
// uncached DB work every call — the open-PR cache scan (`loadOpenPrs`), pause
// reasons, and the automation queue — ~80-100 ms per request. The feed is triage
// state, not real-time, so serving it stale-while-revalidate for a few seconds
// is fine: repeated per-page polls collapse to one background compute, and
// concurrent misses (nav badge + a project page mounting together) single-flight
// to one run instead of each recomputing. Pinned to globalThis because Next.js
// duplicates route modules across bundle realms.
declare global {
  var __tamtamInboxSignalsCache: Map<string, { value: InboxSignalsResult; time: number }> | undefined;
  var __tamtamInboxSignalsInflight: Map<string, Promise<InboxSignalsResult>> | undefined;
}
const INBOX_SIGNALS_TTL_MS = 8_000;

/**
 * Gather the current cross-project state and derive the inbox feed. This is the
 * single entry point the `/api/inbox` and `/api/attention` routes call. The
 * result is the full cross-project set; each route filters it by `?project`
 * itself, so a single cache key ('all') serves both. SWR-cached (see above).
 */
export async function listInboxSignals(): Promise<InboxSignalsResult> {
  const store: SwrStore<InboxSignalsResult> = {
    cache: (globalThis.__tamtamInboxSignalsCache ??= new Map()),
    inflight: (globalThis.__tamtamInboxSignalsInflight ??= new Map()),
  };
  return swrGet(store, 'all', INBOX_SIGNALS_TTL_MS, computeInboxSignals);
}

async function computeInboxSignals(): Promise<InboxSignalsResult> {
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
