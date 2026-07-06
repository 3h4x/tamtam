import { markReviewed, setReviewedRef, getCurrentBranch } from '@/lib/git/git-utils';
import { getVerdict, readLog, readParsedLog } from '@/lib/jobs/verdict';
import { listJobs, getJob, persistVerdict } from '@/lib/jobs/storage';
import { parentContext } from '@/lib/jobs/parent-context';
import type { JobData } from '@/lib/jobs/types';
import { hasFreshLgtm, hasLocalCommitsAhead } from '@/lib/pipeline/release-state';
import { getPushFixAttemptCap, getFixIterationCap } from '@/lib/pipeline/recovery-budget';
import {
  findLatestIssueRunContext,
  findReleaseScopedIssueContext,
  parsePrContextMeta,
} from '@/lib/pipeline/release-context';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes';
import {
  PIPELINE_STEP_KINDS,
  appendToReleaseLog,
  buildUnverifiedCriteriaFindings,
  findLatestReviewForRelease,
  findLinkedActiveReleaseJob,
  fixContradictsReview,
  getProjectPipelineConfig,
  isDoNotShipReview,
  noteReleaseStop,
  notifyReleaseAborted,
  persistReleaseStopReason,
  pipelineExitCodeForStep,
  recentFixFromPushCount,
  recentStepCount,
  reviewIsStuck,
  reviewSourceType,
  toStreamTextLine,
  tryReviewExhaustionFallback,
} from '@/lib/jobs/lifecycle-helpers';
import { finalizeAbortedRelease, finalizeReleaseJob } from './finalization';
import { runAgentCompletionHooks } from './agent-completion-hooks';
import { runPostCompletionHooks } from './post-completion-hooks';

export { PIPELINE_STEP_KINDS } from '@/lib/jobs/lifecycle-helpers';

export async function runCompletionHooks(job: JobData): Promise<void> {
  // Run the entire hook body inside a parent context so any child job spawned
  // by a chain (test→fix, review→commit, push→pr-wait, agent→release, …)
  // automatically records `parent_job_id = job.id`. createJob reads from this
  // AsyncLocalStorage when no explicit parent is passed, giving us a free
  // "who started whom" link without threading parameters through every helper.
  return parentContext.run(job.id, () => runCompletionHooksInner(job));
}

async function runCompletionHooksInner(job: JobData): Promise<void> {
  // Stream per-step output into the active release meta-log so the user can
  // watch the whole pipeline in one terminal.
  if (['test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'mark-dod'].includes(job.kind)) {
    const release = findLinkedActiveReleaseJob(job);
    if (release) appendToReleaseLog(release, job.kind, job);
  }

  await runAgentCompletionHooks(job);

  // Operator-initiated conflict resolution is a standalone (non-pipeline) job:
  // on completion, verify the rebase, force-push-with-lease, and hand off to
  // pr-wait — or re-raise the conflict HITL on failure. It never participates
  // in release chaining, so handle it here and return (mirrors how fix-ci stays
  // out of the chain). markDone runs this on live completion AND on probe
  // recovery after a restart (resolve-conflicts is a Claude-backed kind), so the
  // finalize is restart-safe.
  if (job.kind === 'resolve-conflicts') {
    try {
      const { finalizeResolveConflicts } = await import('@/lib/jobs/resolve-conflicts');
      await finalizeResolveConflicts(job);
    } catch (err) {
      console.error(`[resolve-conflicts] finalize failed for ${job.id}:`, err);
    }
    return;
  }

  // If the release was aborted while this step was running, do not chain to
  // the next step. The abort handler sets finishedAt on the release job, so
  // findActiveReleaseJob (which filters finishedAt === null) won't find it.
  // Use job.releaseId + getJob() to check the abortedAt flag directly.
  if (job.releaseId) {
    const releaseForAbortCheck = getJob(job.releaseId);
    if (releaseForAbortCheck?.abortedAt) {
      console.log(`[release] job ${job.id} (${job.kind}) completed after abort — not chaining`);
      if (job.finishedAt !== null && releaseForAbortCheck.finishedAt === null) {
        await finalizeAbortedRelease(releaseForAbortCheck);
        await notifyReleaseAborted(releaseForAbortCheck);
      }
      return;
    }
  }

  // Release-linked chain short-circuit: every release runs through the
  // Vercel Workflow orchestrator (lib/workflows/release-orchestrator.ts),
  // which now owns chaining + convergence guards + iteration caps +
  // exhaustion fallback (see lib/workflows/guards/{review-convergence,
  // iteration-caps,apply-release-guards}.ts).
  //
  // The chain-spawning blocks below (test→review, review→fix/push, commit
  // →push, push→fix-from-hook, fix→re-verify) are now dead code for
  // release-linked pipeline steps — every cascade since the parentContext
  // fix lands here without ever falling through to a chain block.
  //
  // The abort + release-log-streaming + release-after-run + token-extract
  // + notification + project-board-sync paths above the early-return are
  // intentionally NOT short-circuited — they are observability /
  // bookkeeping, not orchestration. Standalone (no-releaseId) pipeline
  // jobs still flow through the chain blocks below: those have no
  // orchestrator and the chain remains the only way they can recover.
  //
  // Earlier the short-circuit gated on `isWorkflowDriven`, but cascade #3
  // proved that's fragile — when the workflow runtime failed to stamp
  // `releaseId` on a spawned step (parentContext gap), `isWorkflowDriven`
  // returned false and the chain blocks double-dispatched alongside the
  // orchestrator. Gating on `releaseId` directly is defense in depth: any
  // release-linked job is owned by the orchestrator, full stop.
  if (['test', 'review', 'fix', 'commit', 'push', 'mark-dod'].includes(job.kind) && job.releaseId) {
    console.log(`[release] job ${job.id} (${job.kind}) is release-linked — orchestrator owns chaining; skipping legacy hook chain`);
    return;
  }

  // Auto-chain gate: the current step's results are already persisted; if a
  // hard gate is closed (pause, 5h quota, credits), don't kick off the next one.
  if (['test', 'review', 'fix', 'commit', 'push', 'mark-dod'].includes(job.kind)) {
    const { runAutoChainGates } = await import('@/lib/shared/job-control');
    const gate = runAutoChainGates(`continue ${job.kind} chain`);
    if (gate) {
      console.log(`[release] auto-chain halted after ${job.kind} for ${job.project}: ${gate.detail}`);
      const release = findLinkedActiveReleaseJob(job);
      if (release) {
        appendToReleaseLog(release, job.kind, { ...job, kind: 'chain-halt' as JobData['kind'] });
        await finalizeReleaseJob(release, 1);
      }
      return;
    }
  }

  // Tracks whether this hook kicked off a downstream step. If not, the
  // release meta-job is at a natural endpoint and should be finalized so the
  // UI doesn't render it as "live" forever.
  let chainedNext = false;
  let notificationEvent: import('@/lib/shared/notifications').NotificationEvent | null = null;
  let forcedReleaseExitCode: number | null = null;
  let releaseStopReason: string | null = null;

  if (job.kind === 'review') {
    if (job.exitCode === 0) {
      try {
        const { resolveProjectPath } = await import('@/lib/shared/project-data');
        const projPath = resolveProjectPath(job.project);
        if (projPath && reviewSourceType(job) !== 'pr_review') {
          await markReviewed(job.project, projPath);
        }
      } catch {}
      // Downgrade LGTM when the review log marks acceptance criteria as [ ].
      // Runs before the early persist so both pipeline and standalone reviews
      // get the correct verdict — standalone reviews never reach the pipeline
      // branch below, so this is their only opportunity to be downgraded.
      let earlyVerdict = getVerdict(job);
      if (earlyVerdict === 'LGTM') {
        try {
          const { parseVerifiedCriteria } = await import('@/lib/pipeline/review-contract');
          const reviewText = readParsedLog(job);
          const allCriteria = parseVerifiedCriteria(reviewText);
          const unverified = allCriteria.filter(c => !c.verified);
          if (unverified.length > 0) {
            const syntheticFindings = buildUnverifiedCriteriaFindings(unverified);
            if (job.logPath) {
              try { appendRedactedFileSync(job.logPath, toStreamTextLine(syntheticFindings)); } catch {}
            }
            earlyVerdict = 'NEEDS ATTENTION';
            console.log(`[release] review ${job.id} downgraded to NEEDS ATTENTION: ${unverified.length} unverified criteria`);
          }
        } catch (e) {
          console.log(`[release] criteria downgrade check failed for ${job.id}:`, e);
        }
      }
      // Persist verdict so it survives log pruning (standalone and pipeline reviews).
      // Pipeline reviews may persist again at the end of the pipeline branch;
      // persistVerdict updates job.verdict in-cache so getVerdict() there reads
      // the already-downgraded value and writes the same value a second time.
      if (earlyVerdict) persistVerdict(job.id, earlyVerdict);
    }
    // Release pipeline: review LGTM → push; NEEDS ATTENTION/DO NOT SHIP → fix.
    // A read-only PR-diff review (sourceType 'pr_review') must NEVER enter this
    // chain: it reviews the PR branch's diff but the working copy is on the
    // default branch, so committing/pushing/fixing here operates on the wrong
    // tree (historically a phantom no-op commit+push). PR reviews route to
    // their own merge handoff below (maybeAutoMergeAfterPrReview), not here.
    // Mirrors the pr_review guards already used for markReviewed (above) and
    // the reviewed-ref (below).
    try {
      const inRelease = !!findLinkedActiveReleaseJob(job);
      const pipelineCfg = await getProjectPipelineConfig(job.project);
      if (job.exitCode === 0 && reviewSourceType(job) !== 'pr_review' && (inRelease || pipelineCfg.autoPushEnabled || pipelineCfg.autoCommitEnabled)) {
        // Treat a missing verdict as NEEDS ATTENTION rather than silently
        // finalizing as success. Models sometimes narrate a problem and
        // propose a fix without emitting the formal "Verdict: X" line —
        // shipping in that case is dangerous. The fix loop is idempotent
        // (Claude will re-review and emit LGTM if nothing's broken).
        let rawVerdict = getVerdict(job);
        if (!rawVerdict) {
          // One-shot rescue: ask the fast tier to classify the existing review text
          // before we burn a full fix iteration on a parsing artifact.
          // Gated by `review_retry_on_parse_failure` (default on).
          try {
            const { retryVerdictWithClaude } = await import('@/lib/jobs/verdict-retry');
            rawVerdict = await retryVerdictWithClaude(job);
          } catch (e) {
            console.log(`[release] verdict retry failed for ${job.id}:`, e);
          }
        }
        let verdict = rawVerdict ?? 'NEEDS ATTENTION';
        if (!rawVerdict) {
          console.log(`[release] review ${job.id} emitted no verdict — defaulting to NEEDS ATTENTION`);
        }
        // Criteria downgrade (LGTM → NEEDS ATTENTION) was already applied in the
        // exitCode===0 block above; persistVerdict there updated job.verdict so
        // getVerdict() returned the correct (possibly downgraded) value as rawVerdict.
        // Persist again to keep the pipeline branch self-contained and ensure any
        // retry-rescued verdict is also written (same value — harmless second write).
        persistVerdict(job.id, verdict);
        if (verdict === 'LGTM') {
          // Pin the "last LGTM'd commit" as a git ref so the next review can
          // narrow its scope from `@{u}..HEAD` to `<ref>..HEAD`. Skipped when
          // incremental_review_enabled is off, on detached HEAD (no branch), on
          // PR-diff reviews (which must not affect local review scope), or when
          // the ref write fails. Best-effort: failures don't affect the release.
          try {
            const { getSettings: getSettingsForRef } = await import('@/lib/shared/config');
            if (getSettingsForRef().incremental_review_enabled && reviewSourceType(job) !== 'pr_review') {
              const { resolveProjectPath } = await import('@/lib/shared/project-data');
              const projPath = resolveProjectPath(job.project);
              if (projPath) {
                const branch = await getCurrentBranch(projPath);
                if (branch) await setReviewedRef(projPath, branch);
              }
            }
          } catch (e) {
            console.log(`[release] failed to set reviewed ref for ${job.project}:`, e);
          }

          // DoD verification is now gated only by issue linkage. When
          // auto_pr_merge_enabled is on, defer DoD to launchPrWait
          // (post-merge) so verification reflects the merged state.
          const hasIssueContext = (
            findReleaseScopedIssueContext(job.project) ??
            findLatestIssueRunContext(job.project)
          ) !== null;
          const shouldRunDod = hasIssueContext;
          const shouldDeferDod = shouldRunDod && pipelineCfg.autoPrMergeEnabled;
          if (shouldRunDod && !shouldDeferDod) {
            try {
              const { startMarkDod } = await import('@/lib/pipeline/start-mark-dod');
              const md = await startMarkDod(job.project);
              if (md.ok) {
                console.log(`[release] DoD verification for #${md.issueNumber}: ${md.verified}/${md.total} verified${md.changed ? ' (issue updated)' : ''}`);
              }
            } catch (e) {
              console.log(`[release] mark-dod error for ${job.project}:`, e);
            }
          } else if (shouldDeferDod) {
            console.log(`[release] deferring mark-dod to post-merge for ${job.project} (auto_pr_merge_enabled)`);
          } else {
            console.log(`[release] skipping mark-dod for ${job.project} (hasIssueContext=${hasIssueContext})`);
          }
          const commitCount = recentStepCount(job.project, 'commit', job);
          if (commitCount >= getFixIterationCap()) {
            releaseStopReason = `commit cap reached for ${job.project} (${commitCount}/${getFixIterationCap()}) — commits keep cycling, stopping`;
            noteReleaseStop(releaseStopReason);
            notificationEvent = 'fix_loop_exhausted';
            forcedReleaseExitCode = 1;
          } else {
            const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
            const r = await startProjectCommit(job.project);
            if (!r.ok) {
              releaseStopReason = `commit failed for ${job.project}: ${r.detail}`;
              noteReleaseStop(releaseStopReason);
              forcedReleaseExitCode = 1;
            } else {
              console.log(`[release] review LGTM → committed ${job.project} (${r.commitSha || 'no-op'}) (commit #${commitCount + 1})`);
              // startProjectCommit creates a 'commit' job that will itself chain to push
              // (or finalize the release) via its own completion hook.
              chainedNext = true;
            }
          }
        } else if (verdict === 'NEEDS ATTENTION' || verdict === 'DO NOT SHIP') {
          if (verdict === 'DO NOT SHIP') {
            notificationEvent = 'review_do_not_ship';
          }
          // Fixes are unbounded — every NEEDS ATTENTION / DO NOT SHIP triggers
          // a fix. The cap lives on the verification side: review-driven fixes
          // count reviews and bail before starting the next re-test/re-review
          // round. The trailing fix may go unverified, which is the explicit
          // tradeoff: applying the fix is more useful than burning a final
          // review we couldn't act on.
          const contradiction = fixContradictsReview(job);
          const stuck = reviewIsStuck(job);
          if (contradiction.stuck) {
            const legacyStop = `fix claimed ${contradiction.ids.join(', ')} fixed but review still flags them — stopping`;
            if (verdict === 'DO NOT SHIP') {
              notificationEvent = 'review_do_not_ship';
              releaseStopReason = legacyStop;
              noteReleaseStop(releaseStopReason);
              forcedReleaseExitCode = 1;
            } else {
              notificationEvent = 'fix_loop_exhausted';
              const fb = await tryReviewExhaustionFallback(job, 'fix-contradicts-review');
              if (fb.chainedNext) {
                chainedNext = true;
              } else if (fb.releaseStopReason) {
                releaseStopReason = fb.releaseStopReason;
                forcedReleaseExitCode = fb.forcedReleaseExitCode ?? 1;
              } else {
                releaseStopReason = legacyStop;
                noteReleaseStop(releaseStopReason);
                forcedReleaseExitCode = 1;
              }
            }
          } else if (stuck) {
            const legacyStop = `review findings unchanged from previous iteration for ${job.project} — fix not converging, stopping`;
            if (verdict === 'DO NOT SHIP') {
              notificationEvent = 'review_do_not_ship';
              releaseStopReason = legacyStop;
              noteReleaseStop(releaseStopReason);
              forcedReleaseExitCode = 1;
            } else {
              notificationEvent = 'fix_loop_exhausted';
              const fb = await tryReviewExhaustionFallback(job, 'review-stuck');
              if (fb.chainedNext) {
                chainedNext = true;
              } else if (fb.releaseStopReason) {
                releaseStopReason = fb.releaseStopReason;
                forcedReleaseExitCode = fb.forcedReleaseExitCode ?? 1;
              } else {
                releaseStopReason = legacyStop;
                noteReleaseStop(releaseStopReason);
                forcedReleaseExitCode = 1;
              }
            }
          } else {
            const { startFixFromJob } = await import('@/lib/pipeline/start-fix');
            const r = await startFixFromJob(job.id);
            if (r.ok) {
              console.log(`[release] review ${verdict} → started fix ${r.jobId}`);
              chainedNext = true;
            } else {
              releaseStopReason = `skipped fix for ${job.project}: ${r.detail}`;
              noteReleaseStop(releaseStopReason);
              forcedReleaseExitCode = 1;
            }
          }
        }
        // With the default-to-NEEDS-ATTENTION above, verdict is always one of
        // LGTM / NEEDS ATTENTION / DO NOT SHIP here. No null fallthrough.
      }
    } catch (e) {
      console.log(`[release] review hook error for ${job.project}:`, e);
    }

    // Read-only PR-diff review: excluded from the working-copy commit/push chain
    // above. A LGTM on an auto_pr_merge_enabled project instead drives the
    // reviewed PR to merge through pr-wait (CI-green + risky-diff gated,
    // trusted-author only). Fail-closed and best-effort — any decline just
    // leaves the persisted verdict for the operator.
    if (reviewSourceType(job) === 'pr_review' && job.exitCode === 0) {
      try {
        const { maybeAutoMergeAfterPrReview } = await import('@/lib/pipeline/pr-review-merge');
        const r = await maybeAutoMergeAfterPrReview(job);
        console.log(
          r.launched
            ? `[pr-review→pr-wait] started ${r.jobId} for ${job.project} after LGTM`
            : `[pr-review→pr-wait] no auto-merge for ${job.project}: ${r.reason}`,
        );
      } catch (e) {
        console.log(`[pr-review→pr-wait] error for ${job.project}:`, e);
      }
    }
  }

  if (job.kind === 'fix' && job.exitCode === 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      if (!!findLinkedActiveReleaseJob(job) || autoPushEnabled || autoCommitEnabled) {
        // Branch on what triggered this fix. Review-driven fixes also re-run
        // host-side tests first; the normal test→review chain then re-judges
        // the freshly-tested tree.
        const parent = job.parentJobId ? getJob(job.parentJobId) : null;
        const fromTestFailure = parent?.kind === 'test' && parent.exitCode !== null && parent.exitCode !== 0;
        const fromReviewFailure = parent?.kind === 'review';
        const fromCommitFailure = parent?.kind === 'commit' && parent.exitCode !== null && parent.exitCode !== 0;
        const fromPushFailure = parent?.kind === 'push' && parent.exitCode !== null && parent.exitCode !== 0;

        if (fromPushFailure) {
          // Hook rejection (lint/typecheck) blocked the push. After the fix,
          // re-attempt the push — the push helper internally re-stages and
          // re-commits any newly-edited files, so we don't need an explicit
          // commit step in between. Cap on push retries to avoid spinning
          // on a stubbornly-broken hook.
          const pushCount = recentStepCount(job.project, 'push', job);
          if (pushCount >= getFixIterationCap()) {
            releaseStopReason = `push cap reached for ${job.project} (${pushCount}/${getFixIterationCap()}) — push hook keeps rejecting, stopping`;
            noteReleaseStop(releaseStopReason);
            notificationEvent = 'fix_loop_exhausted';
            forcedReleaseExitCode = 1;
          } else {
            const { startProjectPush } = await import('@/lib/pipeline/start-push');
            const r = await startProjectPush(job.project);
            if (r.ok) {
              console.log(`[fix→push] re-running push after fix ${job.id} (push #${pushCount + 1})`);
              chainedNext = true;
            } else {
              releaseStopReason = `skipped re-push for ${job.project}: ${r.detail}`;
              noteReleaseStop(releaseStopReason);
              forcedReleaseExitCode = 1;
            }
          }
        } else if (fromCommitFailure) {
          // Symmetric to fromTestFailure: re-run the commit step that failed
          // (e.g. pre-commit hook caught a regression introduced by the
          // prior fix). Cap on number of commits so a stubbornly-failing
          // hook can't churn commit→fix→commit forever.
          const commitCount = recentStepCount(job.project, 'commit', job);
          if (commitCount >= getFixIterationCap()) {
            releaseStopReason = `commit cap reached for ${job.project} (${commitCount}/${getFixIterationCap()}) — commit keeps failing, stopping`;
            noteReleaseStop(releaseStopReason);
            notificationEvent = 'fix_loop_exhausted';
            forcedReleaseExitCode = 1;
          } else {
            const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
            const r = await startProjectCommit(job.project);
            if (r.ok) {
              console.log(`[fix→commit] re-running commit after fix ${job.id} (commit #${commitCount + 1})`);
              chainedNext = true;
            } else {
              releaseStopReason = `skipped re-commit for ${job.project}: ${r.detail}`;
              noteReleaseStop(releaseStopReason);
              forcedReleaseExitCode = 1;
            }
          }
        } else if (fromTestFailure || fromReviewFailure) {
          // Count verification rounds, not fixes. For review-driven fixes,
          // the re-test is part of the review loop budget: review→fix→test
          // →review still spends review attempts, not the test-failure budget.
          const loopKind = fromReviewFailure ? 'review' : 'test';
          const count = recentStepCount(job.project, loopKind, job);
          const cap = getFixIterationCap();
          if (cap > 0 && count >= cap) {
            if (fromReviewFailure) {
              const legacyStop = `review cap reached for ${job.project} (${count}/${cap}) — review keeps surfacing new findings, stopping`;
              const reviewToCite = findLatestReviewForRelease(job) ?? parent ?? job;
              if (isDoNotShipReview(reviewToCite)) {
                notificationEvent = 'review_do_not_ship';
                releaseStopReason = legacyStop;
                noteReleaseStop(releaseStopReason);
                forcedReleaseExitCode = 1;
              } else {
                notificationEvent = 'fix_loop_exhausted';
                const fb = await tryReviewExhaustionFallback(reviewToCite, 'review-cap');
                if (fb.chainedNext) {
                  chainedNext = true;
                } else if (fb.releaseStopReason) {
                  releaseStopReason = fb.releaseStopReason;
                  forcedReleaseExitCode = fb.forcedReleaseExitCode ?? 1;
                } else {
                  releaseStopReason = legacyStop;
                  noteReleaseStop(releaseStopReason);
                  forcedReleaseExitCode = 1;
                }
              }
            } else {
              releaseStopReason = `test cap reached for ${job.project} (${count}/${cap}) — tests still need verification`;
              noteReleaseStop(releaseStopReason);
              notificationEvent = 'fix_loop_exhausted';
              forcedReleaseExitCode = 1;
            }
          } else {
            let shouldRunHostTest = fromTestFailure;
            if (fromReviewFailure) {
              try {
                const { hasRunnableTestCommand } = await import('@/lib/pipeline/start-test');
                shouldRunHostTest = await hasRunnableTestCommand(job.project);
              } catch {
                shouldRunHostTest = false;
              }
            }

            if (shouldRunHostTest) {
              const { startProjectTest } = await import('@/lib/pipeline/start-test');
              const r = fromReviewFailure
                ? await startProjectTest(job.project, { reviewRetest: true })
                : await startProjectTest(job.project);
              if (r.ok) {
                const label = fromReviewFailure ? 'review re-test' : 'test';
                console.log(`[fix→test] re-running tests after fix ${job.id} (${label} #${count + 1})`);
                chainedNext = true;
              } else {
                releaseStopReason = `skipped re-test for ${job.project}: ${r.detail}`;
                noteReleaseStop(releaseStopReason);
                forcedReleaseExitCode = 1;
              }
            } else {
              const { startProjectReview } = await import('@/lib/pipeline/start-review');
              const r = await startProjectReview(job.project);
              if (r.ok) {
                console.log(`[fix→review] no runnable host test for ${job.project}; re-running review after fix ${job.id} (review #${count + 1})`);
                chainedNext = true;
              } else {
                releaseStopReason = `skipped re-review for ${job.project}: ${r.detail}`;
                noteReleaseStop(releaseStopReason);
                forcedReleaseExitCode = 1;
              }
            }
          }
        } else {
          // Cap on number of reviews — review loops with scope-creeping fixes
          // (each iteration finds *new* findings introduced or exposed by the
          // previous fix) can otherwise loop unbounded since `reviewIsStuck`
          // and `fixContradictsReview` only catch identical-finding repeats.
          // Count completed reviews; bail before starting review #(MAX+1).
          const reviewCount = recentStepCount(job.project, 'review', job);
          const reviewCap = getFixIterationCap();
          if (reviewCap > 0 && reviewCount >= reviewCap) {
            const legacyStop = `review cap reached for ${job.project} (${reviewCount}/${reviewCap}) — review keeps surfacing new findings, stopping`;
            const reviewToCite = findLatestReviewForRelease(job) ?? job;
            if (isDoNotShipReview(reviewToCite)) {
              notificationEvent = 'review_do_not_ship';
              releaseStopReason = legacyStop;
              noteReleaseStop(releaseStopReason);
              forcedReleaseExitCode = 1;
            } else {
              notificationEvent = 'fix_loop_exhausted';
              const fb = await tryReviewExhaustionFallback(reviewToCite, 'review-cap');
              if (fb.chainedNext) {
                chainedNext = true;
              } else if (fb.releaseStopReason) {
                releaseStopReason = fb.releaseStopReason;
                forcedReleaseExitCode = fb.forcedReleaseExitCode ?? 1;
              } else {
                releaseStopReason = legacyStop;
                noteReleaseStop(releaseStopReason);
                forcedReleaseExitCode = 1;
              }
            }
          } else {
            const { startProjectReview } = await import('@/lib/pipeline/start-review');
            const r = await startProjectReview(job.project);
            if (r.ok) {
              console.log(`[fix→review] auto-started review ${r.jobId} for ${job.project} (review #${reviewCount + 1})`);
              chainedNext = true;
            } else {
              releaseStopReason = `skipped auto-review for ${job.project}: ${r.detail}`;
              noteReleaseStop(releaseStopReason);
              forcedReleaseExitCode = 1;
            }
          }
        }
      }
    } catch (e) {
      console.log(`[fix→review] error starting auto-review for ${job.project}:`, e);
    }
  }

  // Symmetric to test-fail and review NEEDS-ATTENTION: a failed commit
  // must trigger a fix that re-attempts the commit, capped on the
  // verification side (commit) by TAMTAM_MAX_STEP_ITERATIONS. Without this
  // path a commit that exits ≠0 (e.g. pre-commit hook caught a lint
  // regression introduced by the prior fix) terminates the release with
  // no recovery attempt. See PIPELINE.md "Auto-fix policy".
  if (job.kind === 'commit' && job.exitCode !== null && job.exitCode !== 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      const inRelease = !!findLinkedActiveReleaseJob(job);
      if (inRelease || autoPushEnabled || autoCommitEnabled) {
        const { startFixFromJob } = await import('@/lib/pipeline/start-fix');
        const r = await startFixFromJob(job.id);
        if (r.ok) {
          console.log(`[release] commit failed → started fix ${r.jobId}`);
          chainedNext = true;
        } else {
          releaseStopReason = `commit→fix skipped for ${job.project}: ${r.detail}`;
          noteReleaseStop(releaseStopReason);
          forcedReleaseExitCode = 1;
        }
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      releaseStopReason = `commit→fix hook errored for ${job.project}: ${detail}`;
      noteReleaseStop(releaseStopReason);
      forcedReleaseExitCode = 1;
      console.log(`[release] commit-fail hook error for ${job.project}:`, e);
    }
  }

  if (job.kind === 'commit' && job.exitCode === 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      const inRelease = !!findLinkedActiveReleaseJob(job);
      if (inRelease || autoPushEnabled) {
        // Release the commit job's pipeline lock before chaining to push —
        // otherwise startProjectPush sees the lock as held (by us) and 409s.
        // In-release chains skip the lock dance via isLockOwnedByActiveRelease,
        // but a standalone commit→push (the "Push to PR" flow) needs the
        // explicit handoff.
        if (!inRelease) {
          try {
            const { releaseLock } = await import('@/lib/pipeline/pipeline-lock');
            await releaseLock(job.project, job.id);
          } catch {}
        }
        const pushCount = recentStepCount(job.project, 'push', job);
        if (pushCount >= getFixIterationCap()) {
          releaseStopReason = `push cap reached for ${job.project} (${pushCount}/${getFixIterationCap()}) — pushes keep cycling, stopping`;
          noteReleaseStop(releaseStopReason);
          notificationEvent = 'fix_loop_exhausted';
          forcedReleaseExitCode = 1;
        } else {
          const { startProjectPush } = await import('@/lib/pipeline/start-push');
          const r = await startProjectPush(job.project);
          if (r.ok) {
            chainedNext = true;
            console.log(`[commit→push] pushed ${job.project} (${r.commitSha || 'no-op'}) (push #${pushCount + 1})`);
          } else {
            releaseStopReason = `push failed for ${job.project}: ${r.detail}`;
            noteReleaseStop(releaseStopReason);
            forcedReleaseExitCode = 1;
          }
        }
      } else if (autoCommitEnabled && !autoPushEnabled) {
        // commit-only mode: commit is done, no push needed — finalize here
        console.log(`[commit] commit-only mode — not chaining to push for ${job.project}`);
      }
    } catch (e) {
      console.log(`[commit→push] error for ${job.project}:`, e);
    }
  }

  if (job.kind === 'test' && job.exitCode === 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      const inRelease = !!findLinkedActiveReleaseJob(job);
      if (inRelease || autoPushEnabled || autoCommitEnabled) {
        const { resolveProjectPath } = await import('@/lib/shared/project-data');
        const { exec } = await import('@/lib/shared/shell');
        const projPath = resolveProjectPath(job.project);
        const changesR = projPath
          ? await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 })
          : null;
        const hasUncommittedChanges = changesR?.exitCode === 0 && changesR.stdout.trim().length > 0;
        const hasUnpushedCommits = projPath && !hasUncommittedChanges
          ? await hasLocalCommitsAhead(projPath)
          : false;
        const freshLgtm = projPath && !hasUncommittedChanges && hasUnpushedCommits
          ? await hasFreshLgtm(job.project, projPath)
          : false;
        const { isReviewRetestJob } = await import('@/lib/pipeline/start-test');
        const isReviewRetest = isReviewRetestJob(job);

        if (isReviewRetest) {
          const { startProjectReview } = await import('@/lib/pipeline/start-review');
          const r = await startProjectReview(job.project);
          if (r.ok) {
            console.log(`[release] review re-test passed → started review ${r.jobId} for ${job.project}`);
            chainedNext = true;
          } else {
            releaseStopReason = `review re-test→review skipped for ${job.project}: ${r.detail}`;
            noteReleaseStop(releaseStopReason);
            forcedReleaseExitCode = 1;
          }
        } else if (hasUncommittedChanges || hasUnpushedCommits) {
          // Review disabled → skip straight to commit (agent prompt covers review).
          const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
          const reviewDisabled = !!(await getProjectTestConfig(job.project))?.reviewDisabled;
          if (freshLgtm) {
            const pushCount = recentStepCount(job.project, 'push', job);
            if (pushCount >= getFixIterationCap()) {
              releaseStopReason = `push cap reached for ${job.project} (${pushCount}/${getFixIterationCap()}) — pushes keep cycling, stopping`;
              noteReleaseStop(releaseStopReason);
              notificationEvent = 'fix_loop_exhausted';
              forcedReleaseExitCode = 1;
            } else {
              const { startProjectPush } = await import('@/lib/pipeline/start-push');
              const r = await startProjectPush(job.project);
              if (r.ok) {
                console.log(`[release] tests passed + fresh LGTM → push ${job.project} (push #${pushCount + 1})`);
                chainedNext = true;
              } else {
                releaseStopReason = `test→push skipped for ${job.project}: ${r.detail}`;
                noteReleaseStop(releaseStopReason);
                forcedReleaseExitCode = 1;
              }
            }
          } else if (reviewDisabled && hasUncommittedChanges) {
            const commitCount = recentStepCount(job.project, 'commit', job);
            if (commitCount >= getFixIterationCap()) {
              releaseStopReason = `commit cap reached for ${job.project} (${commitCount}/${getFixIterationCap()}) — commits keep cycling, stopping`;
              noteReleaseStop(releaseStopReason);
              notificationEvent = 'fix_loop_exhausted';
              forcedReleaseExitCode = 1;
            } else {
              const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
              const r = await startProjectCommit(job.project);
              if (r.ok) {
                console.log(`[release] tests passed + review disabled → commit for ${job.project} (commit #${commitCount + 1})`);
                chainedNext = true;
              } else {
                releaseStopReason = `test→commit skipped for ${job.project}: ${r.detail}`;
                noteReleaseStop(releaseStopReason);
                forcedReleaseExitCode = 1;
              }
            }
          } else if (reviewDisabled && hasUnpushedCommits) {
            const { startProjectPush } = await import('@/lib/pipeline/start-push');
            const r = await startProjectPush(job.project);
            if (r.ok) {
              console.log(`[release] tests passed + review disabled + existing commits → push ${job.project}`);
              chainedNext = true;
            } else {
              releaseStopReason = `test→push skipped for ${job.project}: ${r.detail}`;
              noteReleaseStop(releaseStopReason);
              forcedReleaseExitCode = 1;
            }
          } else {
            const { startProjectReview } = await import('@/lib/pipeline/start-review');
            const r = await startProjectReview(job.project);
            if (r.ok) {
              console.log(`[release] tests passed → started review ${r.jobId} for ${job.project}`);
              chainedNext = true;
            } else {
              releaseStopReason = `test→review skipped for ${job.project}: ${r.detail}`;
              noteReleaseStop(releaseStopReason);
              forcedReleaseExitCode = 1;
            }
          }
        } else {
          // Tests passed and nothing to commit — push existing commits directly.
          const { startProjectPush } = await import('@/lib/pipeline/start-push');
          const r = await startProjectPush(job.project);
          if (r.ok) {
            console.log(`[release] tests passed (no changes) → push ${job.project}`);
            chainedNext = true;
          } else {
            releaseStopReason = `test→push skipped for ${job.project}: ${r.detail}`;
            noteReleaseStop(releaseStopReason);
            forcedReleaseExitCode = 1;
          }
        }
      }
    } catch (e) {
      console.log(`[release] test hook error for ${job.project}:`, e);
    }
  }

  // Test failed: kick off a fix job using the test log. A successful fix
  // chains back through test → review → commit → push. Fixes are unbounded —
  // the loop is bounded on the verification side (next test/review).
  if (job.kind === 'test' && job.exitCode !== null && job.exitCode !== 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      const inRelease = !!findLinkedActiveReleaseJob(job);
      if (inRelease || autoPushEnabled || autoCommitEnabled) {
        const { startFixFromJob } = await import('@/lib/pipeline/start-fix');
        const r = await startFixFromJob(job.id);
        if (r.ok) {
          console.log(`[release] test failed → started fix ${r.jobId}`);
          chainedNext = true;
        } else {
          releaseStopReason = `test→fix skipped for ${job.project}: ${r.detail}`;
          noteReleaseStop(releaseStopReason);
          forcedReleaseExitCode = 1;
        }
      }
    } catch (e) {
      // Without forcing an exit code here, the release stays in `running`
      // forever: the finalize block at the bottom of this function uses
      // `pipelineExitCodeForStep(job)` which is 1 for a failed test, but
      // any throw between finding the release and starting the fix (e.g.
      // dynamic-import failure, transient DB error) would skip both the
      // ok/!ok branches above and leave `forcedReleaseExitCode` null —
      // historically harmless except that we then *also* lose the ability
      // to surface the cause to operators. Pin the exit code + stop
      // reason so the release lands on disk as a failure no matter what.
      const detail = e instanceof Error ? e.message : String(e);
      releaseStopReason = `test→fix hook errored for ${job.project}: ${detail}`;
      noteReleaseStop(releaseStopReason);
      forcedReleaseExitCode = 1;
      console.log(`[release] test-fail hook error for ${job.project}:`, e);
    }
  }

  // Auto-merge: when a push succeeds with a PR and auto_pr_merge_enabled is on,
  // launch a pr-wait job that polls checks and merges once they pass.
  if (job.kind === 'push' && job.exitCode === 0) {
    try {
      const { autoPrMergeEnabled } = await getProjectPipelineConfig(job.project);
      if (autoPrMergeEnabled && job.contextMeta) {
        const meta = JSON.parse(job.contextMeta) as { prUrl?: string; prNumber?: number; prRepo?: string };
        if (meta.prUrl && meta.prNumber && meta.prRepo) {
          const { launchPrWait } = await import('@/lib/pipeline/start-pr-wait');
          // In-release continuation — bypass the global pause gate so a
          // mid-pipeline pause flip doesn't strand the active release.
          const r = launchPrWait(job.project, meta.prNumber, meta.prRepo, meta.prUrl, { allowWhilePaused: true });
          if ('jobId' in r) {
            console.log(`[push→pr-wait] started pr-wait ${r.jobId} for PR #${meta.prNumber}`);
            chainedNext = true;
          } else {
            console.log(`[push→pr-wait] failed to start pr-wait: ${r.error}`);
          }
        }
      } else if (!autoPrMergeEnabled && job.contextMeta) {
        // PR exists but no auto-merge (covers both PR Workflow and Direct Branch
        // issue-linked pushes that create a PR): run DoD now. The auto-merge path
        // defers this to post-merge in launchPrWait.
        //
        // DoD verification reads the *issue* body's `- [ ]` checklist when the
        // push is issue-linked — the PR body usually doesn't carry the
        // acceptance criteria. Fall back to the PR body only when there is no
        // linked issue (a generic-PR feature branch).
        const meta = parsePrContextMeta(job.contextMeta);
        if (meta) {
          try {
            const { startMarkDod } = await import('@/lib/pipeline/start-mark-dod');
            const dodTarget = job.ghIssueNumber && job.ghIssueRepo
              ? { issueNumber: job.ghIssueNumber, repo: job.ghIssueRepo }
              : { prNumber: meta.number, repo: meta.repo };
            const md = await startMarkDod(job.project, dodTarget);
            if (md.ok) {
              const targetLabel = 'issueNumber' in dodTarget
                ? `issue #${dodTarget.issueNumber}`
                : `PR #${dodTarget.prNumber}`;
              console.log(`[push→dod] ${targetLabel} DoD: ${md.verified}/${md.total} verified${md.changed ? ' (updated)' : ''}`);
            }
          } catch (e) {
            console.log(`[push→dod] mark-dod error for ${job.project}:`, e);
          }
        }
      }
    } catch (e) {
      console.log(`[push→pr-wait] error for ${job.project}:`, e);
    }
  }

  // Auto-fix from a push hook rejection: when a push fails because of a
  // pre-commit / pre-push hook (husky/eslint/lint-staged), spawn a generic
  // fix job that reads the hook error from the push log and edits the code.
  // The downstream `fix → re-push` chain is handled by the fromPushFailure
  // branch below. Bounded by the dedicated push-fix cap so the release
  // wall-clock timeout remains the ultimate stop on stubborn loops.
  if (job.kind === 'push' && job.exitCode !== 0 && !isCancelledExitCode(job.exitCode)) {
    try {
      const rawLog = readLog(job, 100_000);
      const { isHookRejection, isTestFailureRejection, isRemoteRaceRejection } = await import('@/lib/pipeline/push-rejection');
      // Remote race / branch-protection cases first: an LLM fix can't repair
      // a non-fast-forward conflict or a missing PR. start-push already
      // auto-rebases on the common variants; if the failure still surfaces
      // here it means rebase couldn't recover or branch protection blocks
      // the direct push. Stop the pipeline cleanly with a clear reason
      // instead of churning a doomed fix job.
      if (isRemoteRaceRejection(rawLog)) {
        const protectionHint = /Changes must be made through a pull request|required status check|protected branch/i.test(rawLog)
          ? 'branch protection requires a PR'
          : 'remote moved during push';
        releaseStopReason = `push blocked: ${protectionHint} for ${job.project} — re-run release`;
        noteReleaseStop(releaseStopReason);
        forcedReleaseExitCode = 1;
        console.log(`[push] ${protectionHint} for ${job.project} — not spawning fix job`);
      } else if (isTestFailureRejection(rawLog)) {
        // Pre-push hook ran tests and they failed. The fix loop is tuned for
        // lint/typecheck nits, not for diagnosing test failures (especially
        // flakes). Stop the pipeline and surface the failure so a human can
        // decide whether to skip, fix, or rerun.
        releaseStopReason = `push blocked: pre-push hook tests failed for ${job.project}`;
        noteReleaseStop(releaseStopReason);
        forcedReleaseExitCode = 1;
        console.log(`[push] pre-push tests failed for ${job.project} — not auto-retrying`);
      } else if (isHookRejection(rawLog)) {
        const attempts = recentFixFromPushCount(job.project);
        const cap = getPushFixAttemptCap();
        if (attempts < cap) {
          const { computeFixBackoffSeconds } = await import('@/lib/workflows/dispatch-phase');
          const { getSettings } = await import('@/lib/shared/config');
          const backoff = computeFixBackoffSeconds(attempts, getSettings().review_fix_backoff_seconds);
          if (backoff > 0) {
            console.log(`[push] hook rejection backoff ${backoff}s before fix attempt ${attempts + 1}`);
            await new Promise((res) => setTimeout(res, backoff * 1000));
          }
          const { startFixFromJob } = await import('@/lib/pipeline/start-fix');
          const r = await startFixFromJob(job.id);
          if (r.ok) {
            console.log(`[push] hook rejection → auto-fix ${r.jobId} (attempt ${attempts + 1}/${cap})`);
            chainedNext = true;
          } else {
            console.log(`[push] hook rejection — could not start fix: ${r.detail}`);
          }
        } else {
          releaseStopReason = `push fix cap reached for ${job.project} (${attempts}/${cap}) — push hook failures still need recovery`;
          noteReleaseStop(releaseStopReason);
          notificationEvent = 'fix_loop_exhausted';
          forcedReleaseExitCode = 1;
          console.log(`[push] hook rejection — fix cap reached (${attempts}/${cap}) — surfacing error`);
        }
      }
    } catch (e) {
      console.log(`[push] fix hook error for ${job.project}:`, e);
    }
  }

  // If this is a pipeline step and we didn't chain to another step, the
  // release job reached a natural endpoint — finalize it. Exit code mirrors
  // this step's outcome.
  //
  // `mark-dod` is explicitly excluded: it is a best-effort side-step invoked
  // synchronously by the review hook. Treating it as an endpoint here
  // finalizes the release BEFORE the review hook gets to call
  // `startProjectCommit`, so commit/push never fire. Mark-dod's outcome is
  // purely advisory (issue checkbox updates); the release continues via its
  // invoker regardless of mark-dod's exit code.
  if (['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'pr-wait'].includes(job.kind) && !chainedNext) {
    // Guard: if another pipeline step is still running for this project, defer
    // finalization to that step. This prevents a second test (or any other
    // step started by a concurrent pending-release drain) from finalizing the
    // release while review/commit/push from the first test are still in-flight.
    const otherRunningStep = listJobs().find(
      j => j.project === job.project && j.id !== job.id && PIPELINE_STEP_KINDS.has(j.kind) && j.finishedAt === null
    );
    if (otherRunningStep) {
      console.log(`[release] ${job.kind} ${job.id} finished without chaining — deferring finalization (${otherRunningStep.kind} ${otherRunningStep.id} still running for ${job.project})`);
      return;
    }
    const release = findLinkedActiveReleaseJob(job);
    if (release) {
      const exitCode = forcedReleaseExitCode ?? pipelineExitCodeForStep(job);
      if (releaseStopReason) {
        persistReleaseStopReason(release, releaseStopReason);
      }
      if (releaseStopReason && release.logPath) {
        try {
          appendRedactedFileSync(release.logPath, `\n# release stopped — ${releaseStopReason}\n`);
        } catch {}
      }
      // Emit release success/fail notification before finalizing
      if (!notificationEvent) {
        notificationEvent = release.abortedAt != null
          ? 'release_aborted'
          : exitCode === 0
            ? 'release_success'
            : 'release_fail';
      }
      await finalizeReleaseJob(release, exitCode);
    } else {
      // No active release job — still need to release the lock if this was a standalone pipeline job
      try {
        const { releaseLock } = await import('@/lib/pipeline/pipeline-lock');
        await releaseLock(job.project, job.id);
      } catch {}
    }
  }

  await runPostCompletionHooks(job, notificationEvent, forcedReleaseExitCode);
}
