// The state machine.
//
// `releaseOrchestratorWorkflow` takes a sub-step jobId, waits for it to
// finish, decides the next phase, and dispatches the matching phase
// workflow — which itself is a child workflow that runs independently and,
// when finished, can dispatch the next orchestrator tick for ITS sub-step
// jobId. The chain self-perpetuates, but instead of POLLING for the next
// sibling job that completion hooks spawned, it DRIVES the next phase
// directly.
//
// Always active for releases. The completion-hook chain in
// lib/jobs/lifecycle.ts short-circuits on `releaseId` for any release-
// linked pipeline step, so the orchestrator owns dispatch alone (no
// double-dispatch). The `workflowDriven` contextMeta flag this used to
// rely on was retired — gating on linkage is robust by construction.

import type { WaitForJobResult } from '@/lib/workflows/wait-for-job';
import type { NextPhase } from '@/lib/workflows/decide-next-phase';
import type { DispatchContext, DispatchPhaseOutcome } from '@/lib/workflows/dispatch-phase';
import { statusHasNonTamtamPath, statusHasOnlyCommittedTamtamMetadataPaths } from '@/lib/pipeline/review-scope';

export interface OrchestratorTickResult {
  waited: WaitForJobResult;
  decision: NextPhase | null;
  dispatch: DispatchPhaseOutcome | null;
}

export async function releaseOrchestratorWorkflow(
  jobId: string,
  ctx: DispatchContext,
): Promise<OrchestratorTickResult> {
  'use workflow';
  const waited = await waitStep(jobId);
  if (!waited.finished || !waited.job) return { waited, decision: null, dispatch: null };
  if (ctx.parentJobId && await releaseAlreadyFinalizedStep(ctx.parentJobId)) {
    return { waited, decision: null, dispatch: null };
  }
  if (ctx.parentJobId) {
    const budgetStop = await checkReleaseBudgetStep(waited.job.project, ctx.parentJobId);
    if (budgetStop.exceeded) {
      await finalizeReleaseStep(
        ctx.parentJobId,
        'abort',
        1,
        budgetStop.detail,
      );
      return { waited, decision: null, dispatch: null };
    }
  }
  const decision = await decideStep(waited.job.id);
  // When the guard rewrote a DO NOT SHIP / NEEDS ATTENTION abort into a
  // "ship anyway with follow-up issue" decision, file the GitHub issue with
  // the persistent review findings before dispatching commit. Best-effort:
  // commit still runs if the issue can't be filed (offline gh, permissions,
  // etc.). Logged so operators can see what happened.
  if (decision.next === 'commit' && decision.fileIssueForReviewId) {
    await fileReviewExhaustionIssueStep(
      decision.fileIssueForReviewId,
      ctx.parentJobId ?? null,
    );
  }
  // Propagate PR context to the dispatcher when the decision is to launch
  // pr-wait. Without this, dispatchPhase's required-context check rejects.
  const dispatchCtx: DispatchContext = { ...ctx, prevJobId: waited.job.id };
  if (decision.next === 'pr-wait') {
    dispatchCtx.pr = decision.pr;
  }
  if (decision.next === 'soak') {
    dispatchCtx.soak = decision.soak;
  }
  const dispatch = await dispatchStep(decision, dispatchCtx);
  // Finalize the release meta-job whenever this tick did not start a child
  // workflow — otherwise the release sits in `running` until the wall-clock
  // sweep reaps it. Three cases:
  //   - `terminal`           — decideStep / guards routed to done/abort/unknown.
  //   - `dispatch_failed`    — `start(child)` threw (workflow runtime gap,
  //                            transient queue error, etc.). The chain is
  //                            broken; fail loudly with the underlying error.
  //   - `missing_context`    — the dispatch needed a value (e.g. prevJobId)
  //                            that the caller didn't pass. Programmer error;
  //                            finalize and surface so it doesn't silently
  //                            hang the release.
  //   - `duplicate_suppressed` — another orchestrator run already started this
  //                            phase for the same release. Benign; bow out
  //                            without finalizing so the in-flight child drives
  //                            the chain.
  if (dispatch.dispatched === false && ctx.parentJobId) {
    // Duplicate dispatch suppressed: an in-flight child of this kind already
    // exists for the release (a concurrent orchestrator resume — boot
    // recovery, the completion-event router, or a pre-restart tick — beat us
    // to it). The in-flight child covers the same working tree and the
    // orchestrator tick that owns it will progress the chain. Bow out WITHOUT
    // finalizing: finalizing here would abort a healthy release whose phase is
    // actively running (e.g. an LGTM review still in-flight when a zombie tick
    // from a restart storm tried to re-dispatch review).
    if (dispatch.reason === 'duplicate_suppressed') {
      console.warn(
        `[release-orchestrator] duplicate ${dispatch.phase} dispatch suppressed for ${ctx.parentJobId} — in-flight child owns the chain; leaving release running`,
      );
      return { waited, decision, dispatch };
    }
    // Transient chunk-load dispatch failures (Next.js rewrote .next during
    // a rebuild while this orchestrator tick was importing the next phase
    // workflow) are NOT terminal — the release-reconcile probe sweep will
    // re-dispatch the orchestrator a moment later when the new chunks have
    // landed. Finalizing here would kill a perfectly healthy release.
    // Return early without touching the release row.
    // `dispatched === false` already narrowed by the outer guard; only need
    // to re-narrow on `reason` to access `dispatch.error`.
    if (
      dispatch.reason === 'dispatch_failed' &&
      /Failed to load chunk|Cannot find module|MODULE_NOT_FOUND/i.test(dispatch.error)
    ) {
      console.warn(
        `[release-orchestrator] chunk-load dispatch failure for ${ctx.parentJobId}: ${dispatch.error.slice(0, 200)} — leaving release running for reconcile`,
      );
      return { waited, decision, dispatch };
    }
    // Stash the guard's stop reason on the release before finalizing so the
    // UI / pipeline trace surfaces the abort cause. When the abort came
    // from a review-side guard with a NEEDS ATTENTION verdict (not DO NOT
    // SHIP), file the exhaustion-fallback GitHub issue with the persistent
    // findings so the user has a follow-up artifact.
    const stopReason = computeStopReason(dispatch, decision);
    // When a NEEDS-ATTENTION review cap aborts the chain, file a follow-up
    // GitHub issue against the LATEST review job in the release. Earlier the
    // check required `waited.job.kind === 'review'`, but the cap fires when
    // we're about to dispatch the next review AFTER a fix — at that moment
    // waited.job is the fix, not the review, so the check missed and the
    // exhaustion issue silently never got filed. The actual lookup runs in
    // `findLatestReviewIdStep` so Node module access stays in a `'use step'`
    // body (the workflow body must remain pure / non-Node).
    let fileExhaustionIssueForReviewId: string | undefined;
    if (
      decision.next === 'abort' &&
      decision.from === 'review' &&
      decision.verdict === 'NEEDS ATTENTION'
    ) {
      if (waited.job.kind === 'review') {
        fileExhaustionIssueForReviewId = waited.job.id;
      } else if (ctx.parentJobId) {
        fileExhaustionIssueForReviewId = (await findLatestReviewIdStep(ctx.parentJobId)) ?? undefined;
      }
    }
    // For terminal decisions, the release outcome mirrors the last step's
    // exit code. For dispatch failures, we have no successful chain to point
    // at — propagate exit 1 so the release row goes red rather than
    // inheriting an exit-0 from a successful prior step.
    // Special case: `mark-dod` failure is documented non-fatal in PIPELINE.md
    // (its job is to tick checkboxes on the issue/PR; a failure doesn't
    // invalidate the push that already landed). The most common cause of
    // mark-dod exit != 0 is a PM2 restart killing the inline mark-dod
    // process with exit -1 — the push had succeeded a step earlier and the
    // work is on origin. Coerce to exit 0 so the release row reflects the
    // release's actual outcome instead of cosmetically marking a successful
    // ship as failed.
    let lastExitCode: number;
    if (dispatch.reason === 'terminal') {
      const rawExit = waited.job.exitCode ?? 0;
      if (waited.job.kind === 'mark-dod' && rawExit !== 0) {
        lastExitCode = 0;
      } else {
        lastExitCode = rawExit;
      }
    } else {
      lastExitCode = 1;
    }
    // `dispatch.phase` is the next phase that would have run for
    // dispatch_failed/missing_context, not a real terminal phase. Coerce to
    // 'abort' so finalizeReleaseStep takes the aborted-release path.
    const terminalPhase: 'done' | 'abort' | 'unknown' =
      dispatch.reason === 'terminal'
        ? dispatch.phase
        : 'abort';
    await finalizeReleaseStep(
      ctx.parentJobId,
      terminalPhase,
      lastExitCode,
      stopReason,
      fileExhaustionIssueForReviewId,
    );
  }
  return { waited, decision, dispatch };
}

function computeStopReason(
  dispatch: DispatchPhaseOutcome,
  decision: NextPhase,
): string | undefined {
  if (dispatch.dispatched !== false) return undefined;
  if (dispatch.reason === 'terminal') {
    return decision.next === 'abort' && 'stopReason' in decision
      ? decision.stopReason
      : undefined;
  }
  if (dispatch.reason === 'dispatch_failed') {
    return `failed to dispatch ${dispatch.phase} phase: ${dispatch.error}`;
  }
  if (dispatch.reason === 'missing_context') {
    return `missing context for ${dispatch.phase} dispatch: ${dispatch.missing.join(', ')}`;
  }
  return undefined;
}

async function waitStep(jobId: string): Promise<WaitForJobResult> {
  'use step';
  const { waitForJobCompletion } = await import('@/lib/workflows/wait-for-job');
  return waitForJobCompletion(jobId);
}

async function releaseAlreadyFinalizedStep(releaseJobId: string): Promise<boolean> {
  'use step';
  const { getJob } = await import('@/lib/jobs/job-storage');
  const release = getJob(releaseJobId);
  return release?.kind === 'release' && release.finishedAt !== null;
}

async function checkReleaseBudgetStep(
  projectName: string,
  releaseJobId: string,
): Promise<{ exceeded: false } | { exceeded: true; detail: string }> {
  'use step';
  const { checkReleaseSpendCap } = await import('@/lib/pipeline/spend-guard');
  const block = await checkReleaseSpendCap(projectName, releaseJobId);
  if (block.ok) return { exceeded: false };
  try {
    const { notify } = await import('@/lib/shared/notifications');
    await notify({
      event: 'budget_exceeded',
      project: projectName,
      job_id: releaseJobId,
      status: 'failed',
      reason: 'release_spend_cap',
      cost_usd: block.actualUsd,
      message: `${block.detail}. Cap ${block.capUsd.toFixed(4)}, actual ${block.actualUsd.toFixed(4)}.`,
      throttleKeySuffix: `release:${releaseJobId}`,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.warn('[release-orchestrator] budget-exceeded notification failed:', err);
  }
  return { exceeded: true, detail: block.detail };
}

async function decideStep(jobId: string): Promise<NextPhase> {
  'use step';
  const { getJob, getVerdict, listJobs, readParsedLog } = await import('@/lib/jobs/job-storage');
  const { decideNextPhase } = await import('@/lib/workflows/decide-next-phase');
  const { applyReleaseGuards } = await import('@/lib/workflows/guards/apply-release-guards');
  const {
    getFixIterationCap,
    getPushFixAttemptCap,
    getReviewDoNotShipAction,
  } = await import('@/lib/pipeline/recovery-budget');
  const job = getJob(jobId);
  if (!job) return { next: 'unknown', from: 'unknown', reason: `job ${jobId} not found in cache` };
  const verdict = job.kind === 'review' ? getVerdict(job) : null;
  // Fix completions need the parent's kind to route back to re-verification.
  // Non-fix kinds ignore parentKind so this is harmless when not relevant.
  const parent = job.parentJobId ? getJob(job.parentJobId) : null;
  const parentKind = parent?.kind ?? null;
  // For mark-dod → pr-wait routing under auto-merge: look up the release's
  // most recent push job and inspect its contextMeta for PR identity, then
  // read the project's auto_pr_merge_enabled flag. Cheap (cached) on the
  // happy path because we only do this when kind === 'mark-dod'.
  let pushPrContext: { prNumber: number; prRepo: string; prUrl: string } | null = null;
  let autoPrMergeEnabled = false;
  let reviewDisabled = false;
  let hasUncommittedChanges = false;
  let hasUnpushedCommits = false;
  if (job.kind === 'test' && (job.exitCode ?? -1) === 0) {
    let isReviewRetest = false;
    try {
      const { isReviewRetestJob } = await import('@/lib/pipeline/start-test');
      isReviewRetest = isReviewRetestJob(job);
    } catch {}
    let configReviewDisabled = false;
    if (!isReviewRetest) {
      try {
        const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
        configReviewDisabled = !!(await getProjectTestConfig(job.project))?.reviewDisabled;
        reviewDisabled = configReviewDisabled;
      } catch {}
    }
    try {
      const { resolveProjectPath } = await import('@/lib/shared/project-data');
      const projPath = resolveProjectPath(job.project);
      if (projPath) {
        const { exec } = await import('@/lib/shared/shell');
        const changes = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
        hasUncommittedChanges = changes.exitCode === 0 && changes.stdout.trim().length > 0;
        const hasReviewablePath = changes.exitCode === 0 && statusHasNonTamtamPath(changes.stdout);
        if (!hasUncommittedChanges || !hasReviewablePath) {
          const { hasLocalCommitsAhead } = await import('@/lib/pipeline/release-state');
          hasUnpushedCommits = await hasLocalCommitsAhead(projPath);
        }
        // Route past `review` when the reviewer would have only committed
        // TamTam metadata to look at. `start-review.ts` filters `.tamtam/`
        // paths out of review scope by design (per-project agent config isn't
        // reviewable work) and
        // aborts the release with "No uncommitted changes or unpushed
        // commits to review" if filtering leaves the scope empty — that
        // halts the chain at `test` even though `commit`/`push`/`pr-wait`
        // still have work to do (e.g. shipping a `.tamtam/agents/` rename, or
        // pushing onto a branch whose PR is blocked on a merge conflict).
        // Treat only committed metadata as functionally equivalent to
        // `reviewDisabled` for routing purposes. Local scratch under
        // `.tamtam/cache/**` must not be committed by this bypass.
        const onlyCommittedTamtamMetadata = changes.exitCode === 0
          && statusHasOnlyCommittedTamtamMetadataPaths(changes.stdout);
        const nothingForReviewerToSee = onlyCommittedTamtamMetadata && !hasUnpushedCommits;
        const hasShippableState = hasUncommittedChanges || hasUnpushedCommits;
        if (!isReviewRetest) {
          reviewDisabled = reviewDisabled || (nothingForReviewerToSee && hasShippableState);
        }
      }
    } catch {}
  }
  if (job.kind === 'mark-dod' && job.releaseId) {
    // Single-pass "find most recent successful push for this release"; this
    // avoids allocating the filtered array and the sort.
    let pushJob: ReturnType<typeof getJob> | null = null;
    let maxStartedAt = -Infinity;
    for (const j of listJobs()) {
      if (j.releaseId !== job.releaseId) continue;
      if (j.kind !== 'push') continue;
      if (j.exitCode !== 0) continue;
      const ts = j.startedAt ?? 0;
      if (ts > maxStartedAt) {
        maxStartedAt = ts;
        pushJob = j;
      }
    }
    if (pushJob?.contextMeta) {
      try {
        const meta = JSON.parse(pushJob.contextMeta) as { prUrl?: string; prNumber?: number; prRepo?: string };
        if (meta.prUrl && meta.prNumber && meta.prRepo) {
          pushPrContext = { prUrl: meta.prUrl, prNumber: meta.prNumber, prRepo: meta.prRepo };
        }
      } catch {}
    }
    if (pushPrContext) {
      try {
        const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
        const cfg = await getProjectTestConfig(job.project);
        autoPrMergeEnabled = !!cfg?.autoPrMergeEnabled;
      } catch {}
    }
  }
  // After a successful pr-wait merge, decide whether to enter the soak
  // watch window. Soak is opt-in per project — disabled (0 minutes) means
  // the release ends here just as it did before. We resolve everything the
  // soak phase needs (merge sha + PR identity + default branch) here so
  // the decideNextPhase function stays pure data-in / data-out.
  let soakContext: { mergeSha: string; prNumber: number; prRepo: string; prUrl: string; defaultBranch: string; watchMinutes: number; autoRevert: boolean } | null = null;
  if (job.kind === 'pr-wait' && job.releaseId && (job.exitCode ?? -1) === 0) {
    try {
      const { getProjectSoakConfig } = await import('@/lib/scheduling/scheduling');
      const { isAutoFixCiOnRedDefaultBranchEnabled } = await import('@/lib/jobs/auto-fix-ci-state');
      const soakCfg = await getProjectSoakConfig(job.project);
      // Run the soak watcher when post-merge watch is configured, OR when auto
      // fix-ci is enabled. Soak is the timing-gap-proof home for post-merge
      // auto-fix: it polls the merge SHA's default-branch CI over a window, so
      // it observes a failure whenever it surfaces — unlike the sweep's "idle
      // on default" trigger, which a fast-cycling repo has already left by the
      // time post-merge CI reddens. In auto-fix mode with no explicit
      // post_merge_watch_minutes, use a default window (the poll loop runs
      // until CI terminates regardless, so this is just the on-gate).
      const AUTO_FIX_CI_SOAK_WATCH_MINUTES = 20;
      const configuredWatch = soakCfg?.postMergeWatchMinutes ?? 0;
      const autoFixCiWatch = (await isAutoFixCiOnRedDefaultBranchEnabled()) ? AUTO_FIX_CI_SOAK_WATCH_MINUTES : 0;
      const effectiveWatchMinutes = configuredWatch > 0 ? configuredWatch : autoFixCiWatch;
      if (effectiveWatchMinutes > 0) {
        const prMeta = job.contextMeta ? JSON.parse(job.contextMeta) as { prNumber?: number; prRepo?: string; prUrl?: string } : {};
        if (prMeta.prNumber && prMeta.prRepo && prMeta.prUrl) {
          const { resolveProjectPath } = await import('@/lib/shared/project-data');
          const projPath = resolveProjectPath(job.project);
          if (projPath) {
            const [{ detectMainBranch }, { exec }] = await Promise.all([
              import('@/lib/pipeline/start-commit'),
              import('@/lib/shared/shell'),
            ]);
            // Prefer the PR's recorded merge commit (canonical for squash
            // and rebase merges) and fall back to the local default-branch
            // tip if gh is unavailable. Without the fallback we'd silently
            // skip soak in offline environments.
            let mergeSha = '';
            const [defaultBranch, ghMerge] = await Promise.all([
              detectMainBranch(projPath),
              exec(
                'gh',
                ['pr', 'view', String(prMeta.prNumber), '--repo', prMeta.prRepo, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'],
                { cwd: projPath, timeout: 15_000 },
              ),
            ]);
            if (ghMerge.exitCode === 0) mergeSha = ghMerge.stdout.trim();
            if (!mergeSha) {
              await exec('git', ['-C', projPath, 'fetch', 'origin', defaultBranch], { timeout: 30_000 });
              const shaR = await exec('git', ['-C', projPath, 'rev-parse', `origin/${defaultBranch}`], { timeout: 10_000 });
              if (shaR.exitCode === 0) mergeSha = shaR.stdout.trim();
            }
            if (mergeSha) {
              soakContext = {
                mergeSha,
                prNumber: prMeta.prNumber,
                prRepo: prMeta.prRepo,
                prUrl: prMeta.prUrl,
                defaultBranch,
                watchMinutes: effectiveWatchMinutes,
                autoRevert: soakCfg?.autoRevertEnabled ?? false,
              };
            }
          }
        }
      }
    } catch (err) {
      console.warn('[release-orchestrator] soak context resolution failed:', err);
    }
  }
  // A review-driven fix re-runs the host-side test phase before re-review
  // only when TamTam can actually start a test job. If tests are disabled or
  // no command is detectable, fall back to the original direct re-review path.
  let hostTestsAvailable = true;
  if (job.kind === 'fix' && parentKind === 'review') {
    try {
      const { hasRunnableTestCommand } = await import('@/lib/pipeline/start-test');
      hostTestsAvailable = await hasRunnableTestCommand(job.project);
    } catch {
      hostTestsAvailable = false;
    }
  }
  const decision = decideNextPhase({
    kind: job.kind,
    exitCode: job.exitCode ?? -1,
    verdict,
    parentKind,
    pushPrContext,
    autoPrMergeEnabled,
    reviewDisabled,
    hostTestsAvailable,
    hasUncommittedChanges,
    hasUnpushedCommits,
    soakContext,
  });
  // Pre-dispatch guards: convert `{ next: 'fix' }` into `{ next: 'abort' }`
  // when the fix loop would not converge (reviewIsStuck/fixContradictsReview),
  // or when an iteration cap (review/test/commit/push) is exhausted.
  return applyReleaseGuards({
    job,
    decision,
    deps: {
      listJobs,
      readParsedLog,
      fixIterationCap: getFixIterationCap,
      pushFixAttemptCap: getPushFixAttemptCap,
      reviewDoNotShipAction: getReviewDoNotShipAction,
    },
  });
}

async function dispatchStep(
  decision: NextPhase,
  ctx: DispatchContext,
): Promise<DispatchPhaseOutcome> {
  'use step';
  const { dispatchPhase } = await import('@/lib/workflows/dispatch-phase');
  return dispatchPhase(decision, ctx);
}

async function findLatestReviewIdStep(releaseJobId: string): Promise<string | null> {
  'use step';
  try {
    const { listJobs } = await import('@/lib/jobs/job-storage');
    // Single-pass max by startedAt — was filter().sort()[0].
    let latestId: string | null = null;
    let maxStartedAt = -Infinity;
    for (const j of listJobs()) {
      if (j.releaseId !== releaseJobId) continue;
      if (j.kind !== 'review') continue;
      if (j.finishedAt === null) continue;
      const ts = j.startedAt ?? 0;
      if (ts > maxStartedAt) {
        maxStartedAt = ts;
        latestId = j.id;
      }
    }
    return latestId;
  } catch {
    return null;
  }
}

async function fileReviewExhaustionIssueStep(
  reviewJobId: string,
  releaseJobId: string | null,
): Promise<void> {
  'use step';
  try {
    const { getJob, updateJob } = await import('@/lib/jobs/job-storage');
    const { appendRedactedFileSync } = await import('@/lib/jobs/redacted-log-writer');
    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const reviewJob = getJob(reviewJobId);
    if (!reviewJob) return;
    const r = await fileReviewExhaustionIssue(reviewJob);
    const release = releaseJobId ? getJob(releaseJobId) : null;
    if (r.ok) {
      console.log(`[release] DO NOT SHIP → follow-up issue filed: ${r.issueUrl}; continuing to commit`);
      // Stamp the filed-issue URL on the review job's contextMeta so the
      // UI can surface it on the review row ("→ filed #N"). Without this
      // the audit trail is buried in PM2 logs.
      try {
        const meta = reviewJob.contextMeta ? JSON.parse(reviewJob.contextMeta) : {};
        const merged = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta as Record<string, unknown> : {};
        merged.followupIssueUrl = r.issueUrl;
        if (r.issueNumber) merged.followupIssueNumber = r.issueNumber;
        reviewJob.contextMeta = JSON.stringify(merged);
        updateJob(reviewJob);
      } catch {}
      if (release?.logPath) {
        try {
          appendRedactedFileSync(release.logPath, `# review do-not-ship → follow-up issue: ${r.issueUrl}\n`);
        } catch {}
      }
    } else {
      console.warn(`[release] DO NOT SHIP → failed to file follow-up issue: ${r.error}`);
      if (release?.logPath) {
        try {
          appendRedactedFileSync(
            release.logPath,
            `# review do-not-ship → follow-up issue failed: ${r.error}\n`,
          );
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[release] do-not-ship issue side effect threw:', e);
  }
}

async function finalizeReleaseStep(
  releaseJobId: string,
  terminalPhase: 'done' | 'abort' | 'unknown',
  lastStepExitCode: number,
  stopReason?: string,
  fileExhaustionIssueForReviewId?: string,
): Promise<void> {
  'use step';
  const { getJob, updateJob } = await import('@/lib/jobs/job-storage');
  const { appendRedactedFileSync } = await import('@/lib/jobs/redacted-log-writer');
  const { finalizeReleaseJob, finalizeAbortedRelease } = await import('@/lib/jobs/lifecycle');
  const release = getJob(releaseJobId);
  if (!release || release.kind !== 'release' || release.finishedAt !== null) return;
  // Persist the guard-supplied stop reason on the release row + log so the
  // pipeline trace UI explains why the orchestrator aborted instead of just
  // showing exit -3 with no explanation.
  if (stopReason) {
    try {
      const meta = release.contextMeta ? JSON.parse(release.contextMeta) : {};
      const merged = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta as Record<string, unknown> : {};
      merged.releaseStopReason = stopReason;
      release.contextMeta = JSON.stringify(merged);
      updateJob(release);
    } catch {}
    if (release.logPath) {
      try { appendRedactedFileSync(release.logPath, `\n# release stopped — ${stopReason}\n`); } catch {}
    }
  }
  // Exhaustion fallback: when the orchestrator aborts because the review-side
  // guard exhausted (cap, stuck, contradiction) and the verdict was NEEDS
  // ATTENTION (not DO NOT SHIP), file a GitHub issue with the persistent
  // findings so the user has a concrete follow-up artifact instead of just
  // a red release row. Best-effort: log + continue on failure.
  if (fileExhaustionIssueForReviewId) {
    try {
      const reviewJob = getJob(fileExhaustionIssueForReviewId);
      if (reviewJob) {
        const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
        const r = await fileReviewExhaustionIssue(reviewJob);
        if (r.ok) {
          console.log(`[release] exhaustion issue filed: ${r.issueUrl}`);
          try {
            const m = reviewJob.contextMeta ? JSON.parse(reviewJob.contextMeta) : {};
            const merged = (m && typeof m === 'object' && !Array.isArray(m)) ? m as Record<string, unknown> : {};
            merged.followupIssueUrl = r.issueUrl;
            if (r.issueNumber) merged.followupIssueNumber = r.issueNumber;
            reviewJob.contextMeta = JSON.stringify(merged);
            updateJob(reviewJob);
          } catch {}
          if (release.logPath) {
            try { appendRedactedFileSync(release.logPath, `# exhaustion issue: ${r.issueUrl}\n`); } catch {}
          }
        } else {
          console.warn(`[release] failed to file exhaustion issue: ${r.error}`);
        }
      }
    } catch (e) {
      console.warn('[release] exhaustion-issue side effect threw:', e);
    }
  }
  if (terminalPhase === 'abort') {
    await finalizeAbortedRelease(release);
    return;
  }
  // 'done' or 'unknown' — use the last step's exit code as the release outcome.
  // 'unknown' falls through too: if the orchestrator can't classify the last
  // step (e.g. a release meta-job hitting the orchestrator directly), the
  // safest outcome is to mirror its exit code rather than leave the row open.
  await finalizeReleaseJob(release, lastStepExitCode);
}
