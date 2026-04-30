import { eq } from 'drizzle-orm';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { db, schema } from '@/lib/db';
import { markReviewed } from '@/lib/git/git-utils';
import { parseStreamLines } from './claude-stream-parser';
import { costUsd } from '@/lib/shared/usage-pricing';
import { getVerdict, readLog } from './verdict';
import {
  saveToDb,
  findActiveReleaseJob,
  listJobs,
  getJob,
} from './storage';
import { parentContext } from './parent-context';
import type { JobData } from './types';

async function getProjectPipelineConfig(projectName: string): Promise<{ autoCommitEnabled: boolean; autoPushEnabled: boolean; releaseAfterRun: boolean; autoPrMergeEnabled: boolean; prWorkflowEnabled: boolean }> {
  try {
    const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
    const cfg = getProjectTestConfig(projectName);
    return {
      autoCommitEnabled: !!cfg?.autoCommitEnabled,
      autoPushEnabled: !!cfg?.autoPushEnabled,
      // Default ON: every agent run owns a release. The Project Config tab
      // can opt a repo out (read-only mirrors, archived projects). Older
      // rows still in the DB with `false` are respected — only nullish
      // values get the new default.
      releaseAfterRun: cfg?.releaseAfterRun ?? true,
      autoPrMergeEnabled: !!cfg?.autoPrMergeEnabled,
      prWorkflowEnabled: !!cfg?.prWorkflowEnabled,
    };
  } catch {
    return { autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: true, autoPrMergeEnabled: false, prWorkflowEnabled: false };
  }
}

// Cap runaway review→fix→review loops when auto-push is on. Override via
// TAMTAM_MAX_FIX_ITERATIONS / TAMTAM_FIX_WINDOW_SECONDS for debugging or tuning
// per-environment without a code change.
const MAX_FIX_ITERATIONS = parseInt(process.env.TAMTAM_MAX_FIX_ITERATIONS ?? '', 10) || 3;
const FIX_WINDOW_SECONDS = parseInt(process.env.TAMTAM_FIX_WINDOW_SECONDS ?? '', 10) || 30 * 60;
// fix-ci retries — live-read from settings so the user can tune this in the UI
// without restarting the server. Only crash-fast failures are retried so real
// errors still surface.
async function getFixCiRetryConfig(): Promise<{ maxRetries: number; windowSeconds: number; fastCrashMs: number }> {
  try {
    const { getSettings } = await import('@/lib/shared/config');
    const s = getSettings();
    return {
      maxRetries: s.fix_ci_max_retries,
      windowSeconds: s.fix_ci_retry_window_seconds,
      fastCrashMs: s.fix_ci_fast_crash_ms,
    };
  } catch {
    return { maxRetries: 2, windowSeconds: 120, fastCrashMs: 5000 };
  }
}

function recentFixCiCount(projectName: string, windowSeconds: number): number {
  const cutoff = Date.now() / 1000 - windowSeconds;
  return listJobs().filter(
    (j) => j.project === projectName && j.kind === 'fix-ci' && j.startedAt >= cutoff
  ).length;
}

// Cap auto-fix-push retries so a stubbornly-broken lint rule can't spin
// Claude in a loop. Same 30min window as review-fix for consistency.
const MAX_FIX_PUSH_ATTEMPTS = 2;

function recentFixPushCount(projectName: string): number {
  const cutoff = Date.now() / 1000 - FIX_WINDOW_SECONDS;
  return listJobs().filter(
    (j) => j.project === projectName && j.kind === 'fix-push' && j.startedAt >= cutoff
  ).length;
}

function recentFixCount(projectName: string): number {
  const cutoff = Date.now() / 1000 - FIX_WINDOW_SECONDS;
  return listJobs().filter(
    (j) => j.project === projectName && j.kind === 'fix' && j.startedAt >= cutoff
  ).length;
}

// Build a stable fingerprint of a review's findings list so we can detect
// stuck-in-place fix loops. We strip whitespace, list bullets, code fences,
// and the verdict line itself — only the *content* of the findings should
// drive the hash, not formatting churn.
function findingsFingerprint(reviewLogText: string): string {
  let s = reviewLogText.trim();
  const verdictMatch = s.match(/\n[ \t]*Verdict:[^\n]*\s*$/i);
  if (verdictMatch) s = s.slice(0, verdictMatch.index);
  s = s
    .replace(/```[\s\S]*?```/g, '')         // drop fenced code blocks
    .replace(/^[\s]*[-*•]\s+/gm, '')        // strip bullet markers
    .replace(/^#+\s+/gm, '')                // strip markdown headers
    .replace(/\s+/g, ' ')                   // collapse whitespace
    .trim()
    .toLowerCase();
  // Cheap non-crypto hash; we only need equality, not security.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

// True if the previous review in the same release window produced the same
// findings as the one that just finished — fix isn't making progress, so
// running another iteration won't help.
function reviewIsStuck(currentReview: JobData): boolean {
  if (!currentReview.releaseId) return false;
  const reviews = listJobs()
    .filter(j =>
      j.project === currentReview.project &&
      j.kind === 'review' &&
      j.releaseId === currentReview.releaseId &&
      j.id !== currentReview.id &&
      j.exitCode === 0
    )
    .sort((a, b) => b.startedAt - a.startedAt);
  if (reviews.length === 0) return false;
  const prev = reviews[0];
  try {
    const cur = findingsFingerprint(readLog(currentReview));
    const old = findingsFingerprint(readLog(prev));
    return cur === old && cur.length > 1;
  } catch {
    return false;
  }
}

function appendToReleaseLog(release: JobData, kind: string, job: JobData, extra?: string): void {
  if (!release.logPath) return;
  try {
    const header = `\n\n=== ${kind} (${job.id}) — started ${new Date((job.startedAt || 0) * 1000).toISOString()} — exit ${job.exitCode ?? '?'} ===\n`;
    let body = '';
    if (job.logPath && existsSync(job.logPath)) {
      try { body = readFileSync(job.logPath, 'utf-8'); } catch {}
    }
    appendFileSync(release.logPath, header + body + (extra ? `\n${extra}\n` : ''));
  } catch {}
}

// Safety net: if the given job is a pipeline step, make sure the active
// release for its project eventually gets finalized. The normal path is
// via runCompletionHooks, but races (concurrent probes, a throw mid-hook)
// can leave the release stranded with all its children already done. This
// runs cheaply on every markDone call and only acts when the release has
// no running children and its most recent child finished long enough ago
// that we're confident nothing else is about to chain.
const PIPELINE_STEP_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'pr-wait', 'mark-dod']);
const RELEASE_RECONCILE_GRACE_MS = 5_000;

// A child is part of a release's chain only if it starts shortly after the
// release (or shortly after the previous step finished). Beyond this gap we
// assume an unrelated pipeline job crept in while the release was stuck and
// should NOT be counted in the finalized exit code.
const PIPELINE_CHAIN_GAP_SEC = 60;

export async function reconcileStaleRelease(job: JobData): Promise<void> {
  if (!PIPELINE_STEP_KINDS.has(job.kind)) return;
  const release = findActiveReleaseJob(job.project);
  if (!release) return;
  const now = Date.now() / 1000;
  const releaseStart = release.startedAt || 0;
  // Candidate children: pipeline-step jobs for this project that started at
  // or after the release. Sorted by startedAt so we can walk the chain.
  const candidates = listJobs()
    .filter((j) => j.project === release.project
      && PIPELINE_STEP_KINDS.has(j.kind)
      && (j.startedAt || 0) >= releaseStart - 1)
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  // Walk the chain: accept the first child if it started within the chain
  // gap of the release start, then each subsequent child if it started within
  // the gap of the previous child's finish. Break once the chain breaks —
  // later jobs are unrelated activity.
  const chain: JobData[] = [];
  let edge = releaseStart;
  for (const c of candidates) {
    if ((c.startedAt || 0) - edge > PIPELINE_CHAIN_GAP_SEC) break;
    chain.push(c);
    // If a child is still running, defer: the chain is active.
    if (c.finishedAt === null) return;
    edge = c.finishedAt || edge;
  }
  if (chain.length === 0) return;
  if ((now - edge) * 1000 < RELEASE_RECONCILE_GRACE_MS) return;
  // Belt-and-braces: the in-memory listJobs() snapshot can miss a running
  // pipeline child if the cache was reloaded mid-job (server restart,
  // reset, etc.). Before finalizing, query the DB directly for any
  // pipeline-step job for this project that started at/after the release
  // and is still running. If we find one, defer — the chain is active even
  // if the cache says otherwise.
  // This was the "Release seems broken" bug: a long-running review
  // (>16 min) wasn't visible in listJobs() at probe time, so the chain
  // walk found only the test step and finalized the release with exit 0
  // before review/commit/push had a chance to chain.
  try {
    const stillRunning = db
      .select({ id: schema.jobs.id, kind: schema.jobs.kind, startedAt: schema.jobs.startedAt, finishedAt: schema.jobs.finishedAt })
      .from(schema.jobs)
      .where(eq(schema.jobs.project, release.project))
      .all()
      .filter(r =>
        PIPELINE_STEP_KINDS.has(r.kind)
        && r.finishedAt == null
        && (r.startedAt ?? 0) >= releaseStart - 1,
      );
    if (stillRunning.length > 0) return;
  } catch {
    /* DB error → fall through; better to potentially over-finalize than to
       leave the release "running" forever if the DB is unreachable. */
  }
  const worstExit = chain.reduce(
    (acc, c) => (c.exitCode != null && c.exitCode !== 0 ? 1 : acc),
    0,
  );
  try {
    await finalizeReleaseJob(release, worstExit);
    console.log(`[release] reconciled stale release ${release.id} (${job.project}) — ${chain.length} chained step${chain.length === 1 ? '' : 's'}, exit ${worstExit}`);
  } catch (e) {
    console.log(`[release] reconciler failed for ${release.id}:`, e);
  }
}

async function finalizeReleaseJob(release: JobData, exitCode: number): Promise<void> {
  if (release.finishedAt !== null) return;
  try {
    if (release.logPath) {
      appendFileSync(release.logPath, `\n# release finished — exit ${exitCode} — ${new Date().toISOString()}\n`);
    }
  } catch {}
  await markDone(release, exitCode);
  // Release the pipeline lock
  try {
    const { releaseLock } = await import('@/lib/pipeline/pipeline-lock');
    releaseLock(release.project, release.id);
  } catch {}
}

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
  if (['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'pr-wait', 'mark-dod'].includes(job.kind)) {
    const release = findActiveReleaseJob(job.project);
    if (release) appendToReleaseLog(release, job.kind, job);
  }

  // If the release was aborted while this step was running, do not chain to
  // the next step. The abort handler sets finishedAt on the release job, so
  // findActiveReleaseJob (which filters finishedAt === null) won't find it.
  // Use job.releaseId + getJob() to check the abortedAt flag directly.
  if (job.releaseId) {
    const releaseForAbortCheck = getJob(job.releaseId);
    if (releaseForAbortCheck?.abortedAt) {
      console.log(`[release] job ${job.id} (${job.kind}) completed after abort — not chaining`);
      return;
    }
  }

  // Tracks whether this hook kicked off a downstream step. If not, the
  // release meta-job is at a natural endpoint and should be finalized so the
  // UI doesn't render it as "live" forever.
  let chainedNext = false;
  let notificationEvent: import('@/lib/shared/notifications').NotificationEvent | null = null;

  if (job.kind === 'review') {
    if (job.exitCode === 0) {
      try {
        const { resolveProjectPath } = await import('@/lib/shared/project-data');
        const projPath = resolveProjectPath(job.project);
        if (projPath) await markReviewed(job.project, projPath);
      } catch {}
    }
    // Release pipeline: review LGTM → push; NEEDS ATTENTION/DO NOT SHIP → fix
    try {
      const inRelease = !!findActiveReleaseJob(job.project);
      const pipelineCfg = await getProjectPipelineConfig(job.project);
      if (job.exitCode === 0 && (inRelease || pipelineCfg.autoPushEnabled || pipelineCfg.autoCommitEnabled)) {
        // Treat a missing verdict as NEEDS ATTENTION rather than silently
        // finalizing as success. Models sometimes narrate a problem and
        // propose a fix without emitting the formal "Verdict: X" line —
        // shipping in that case is dangerous. The fix loop is idempotent
        // (Claude will re-review and emit LGTM if nothing's broken).
        const rawVerdict = getVerdict(job);
        const verdict = rawVerdict ?? 'NEEDS ATTENTION';
        if (!rawVerdict) {
          console.log(`[release] review ${job.id} emitted no verdict — defaulting to NEEDS ATTENTION`);
        }
        if (verdict === 'LGTM') {
          // DoD verification only makes sense in PR Workflow mode AND when we
          // have a linked GitHub issue. On a direct-branch release (no PR, no
          // issue) there are no acceptance-criteria checkboxes to tick, so
          // running mark-dod just burns Claude calls and risks stalling the
          // release on an inline claude-cli invocation.
          //
          // When PR Workflow + auto_pr_merge + issue are all set, defer DoD
          // to launchPrWait (post-merge) so verification reflects the merged
          // state. Otherwise (PR Workflow + issue but no auto-merge) run it
          // now so the review can tick boxes before manual merge.
          const hasIssueContext = listJobs().some(
            j => j.project === job.project && j.kind === 'run' && j.ghIssueNumber != null,
          );
          const prWorkflow = !!pipelineCfg.prWorkflowEnabled;
          const shouldRunDod = prWorkflow && hasIssueContext;
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
            console.log(`[release] skipping mark-dod for ${job.project} (pr_workflow_enabled=${prWorkflow}, hasIssueContext=${hasIssueContext})`);
          }
          const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
          const r = await startProjectCommit(job.project);
          if (!r.ok) {
            console.log(`[release] commit failed for ${job.project}: ${r.detail}`);
          } else {
            console.log(`[release] review LGTM → committed ${job.project} (${r.commitSha || 'no-op'})`);
          }
          // startProjectCommit creates a 'commit' job that will itself chain to push
          // (or finalize the release) via its own completion hook.
          chainedNext = true;
        } else if (verdict === 'NEEDS ATTENTION' || verdict === 'DO NOT SHIP') {
          if (verdict === 'DO NOT SHIP') {
            notificationEvent = 'review_do_not_ship';
          }
          const count = recentFixCount(job.project);
          // Convergence guard: if this review listed the same findings as the
          // previous one in this release, fix isn't making progress — abort
          // instead of wasting another iteration on the same nits.
          const stuck = reviewIsStuck(job);
          if (stuck) {
            console.log(`[release] review findings unchanged from previous iteration for ${job.project} — fix not converging, stopping`);
            notificationEvent = 'fix_loop_exhausted';
          } else if (count < MAX_FIX_ITERATIONS) {
            const { startFixFromJob } = await import('@/lib/pipeline/start-fix');
            const r = await startFixFromJob(job.id);
            if (r.ok) {
              console.log(`[release] review ${verdict} → started fix ${r.jobId} (iter ${count + 1})`);
              chainedNext = true;
            } else {
              console.log(`[release] skipped fix for ${job.project}: ${r.detail}`);
            }
          } else {
            console.log(`[release] fix cap reached for ${job.project} (${count}/${MAX_FIX_ITERATIONS}) — stopping`);
            notificationEvent = 'fix_loop_exhausted';
          }
        }
        // With the default-to-NEEDS-ATTENTION above, verdict is always one of
        // LGTM / NEEDS ATTENTION / DO NOT SHIP here. No null fallthrough.
      }
    } catch (e) {
      console.log(`[release] review hook error for ${job.project}:`, e);
    }
  }

  if (job.kind === 'fix' && job.exitCode === 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      if (!!findActiveReleaseJob(job.project) || autoPushEnabled || autoCommitEnabled) {
        // Branch on what triggered this fix: a failing test or a NEEDS_ATTENTION
        // review. Both call into the same `fix` kind, but the recovery path is
        // different — a fix from a test failure must re-run tests (the tests are
        // the source of truth for "is the bug actually fixed"), while a fix
        // from a review must re-run review (the reviewer's checklist is the
        // source of truth there). Previously every fix went straight to review,
        // so a failing test followed by a successful fix would skip the
        // re-test entirely and merge code that hadn't been verified.
        const parent = job.parentJobId ? getJob(job.parentJobId) : null;
        const fromTestFailure = parent?.kind === 'test' && parent.exitCode !== null && parent.exitCode !== 0;

        if (fromTestFailure) {
          // Bounded by the same fix-iteration cap so a persistently-broken test
          // can't churn test→fix→test→fix forever.
          const count = recentFixCount(job.project);
          if (count >= MAX_FIX_ITERATIONS) {
            console.log(`[fix→test] fix cap reached for ${job.project} (${count}/${MAX_FIX_ITERATIONS}) — stopping`);
            notificationEvent = 'fix_loop_exhausted';
          } else {
            const { startProjectTest } = await import('@/lib/pipeline/start-test');
            const r = await startProjectTest(job.project);
            if (r.ok) {
              console.log(`[fix→test] re-running tests after fix ${job.id} (iter ${count})`);
              chainedNext = true;
            } else {
              console.log(`[fix→test] skipped re-test for ${job.project}: ${r.detail}`);
            }
          }
        } else {
          const { startProjectReview } = await import('@/lib/pipeline/start-review');
          const r = await startProjectReview(job.project);
          if (r.ok) {
            console.log(`[fix→review] auto-started review ${r.jobId} for ${job.project}`);
            chainedNext = true;
          } else {
            console.log(`[fix→review] skipped auto-review for ${job.project}: ${r.detail}`);
          }
        }
      }
    } catch (e) {
      console.log(`[fix→review] error starting auto-review for ${job.project}:`, e);
    }
  }

  if (job.kind === 'commit' && job.exitCode === 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      const inRelease = !!findActiveReleaseJob(job.project);
      if (inRelease || autoPushEnabled) {
        // Release the commit job's pipeline lock before chaining to push —
        // otherwise startProjectPush sees the lock as held (by us) and 409s.
        // In-release chains skip the lock dance via isLockOwnedByActiveRelease,
        // but a standalone commit→push (the "Push to PR" flow) needs the
        // explicit handoff.
        if (!inRelease) {
          try {
            const { releaseLock } = await import('@/lib/pipeline/pipeline-lock');
            releaseLock(job.project, job.id);
          } catch {}
        }
        const { startProjectPush } = await import('@/lib/pipeline/start-push');
        const r = await startProjectPush(job.project);
        if (r.ok) {
          chainedNext = true;
          console.log(`[commit→push] pushed ${job.project} (${r.commitSha || 'no-op'})`);
        } else {
          console.log(`[commit→push] push failed for ${job.project}: ${r.detail}`);
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
      const inRelease = !!findActiveReleaseJob(job.project);
      if (inRelease || autoPushEnabled || autoCommitEnabled) {
        const { resolveProjectPath } = await import('@/lib/shared/project-data');
        const { exec } = await import('@/lib/shared/shell');
        const projPath = resolveProjectPath(job.project);
        const changesR = projPath
          ? await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 })
          : null;
        const hasUncommittedChanges = changesR?.exitCode === 0 && changesR.stdout.trim().length > 0;

        if (hasUncommittedChanges) {
          // Review disabled → skip straight to commit (agent prompt covers review).
          const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
          const reviewDisabled = !!getProjectTestConfig(job.project)?.reviewDisabled;
          if (reviewDisabled) {
            const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
            const r = await startProjectCommit(job.project);
            if (r.ok) {
              console.log(`[release] tests passed + review disabled → commit for ${job.project}`);
              chainedNext = true;
            } else {
              console.log(`[release] test→commit skipped for ${job.project}: ${r.detail}`);
            }
          } else {
            const { startProjectReview } = await import('@/lib/pipeline/start-review');
            const r = await startProjectReview(job.project);
            if (r.ok) {
              console.log(`[release] tests passed → started review ${r.jobId} for ${job.project}`);
              chainedNext = true;
            } else {
              console.log(`[release] test→review skipped for ${job.project}: ${r.detail}`);
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
            console.log(`[release] test→push skipped for ${job.project}: ${r.detail}`);
          }
        }
      }
    } catch (e) {
      console.log(`[release] test hook error for ${job.project}:`, e);
    }
  }

  // Test failed: kick off a fix job using the test log. The fix→review hook
  // will then chain to review → commit → push. Bounded by the same fix cap
  // as review→fix so a persistently-broken test can't spin Claude forever.
  if (job.kind === 'test' && job.exitCode !== null && job.exitCode !== 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      const inRelease = !!findActiveReleaseJob(job.project);
      if (inRelease || autoPushEnabled || autoCommitEnabled) {
        const count = recentFixCount(job.project);
        if (count < MAX_FIX_ITERATIONS) {
          const { startFixFromJob } = await import('@/lib/pipeline/start-fix');
          const r = await startFixFromJob(job.id);
          if (r.ok) {
            console.log(`[release] test failed → started fix ${r.jobId} (iter ${count + 1})`);
            chainedNext = true;
          } else {
            console.log(`[release] test→fix skipped for ${job.project}: ${r.detail}`);
          }
        } else {
          console.log(`[release] test→fix cap reached for ${job.project} (${count}/${MAX_FIX_ITERATIONS}) — stopping`);
          notificationEvent = 'fix_loop_exhausted';
        }
      }
    } catch (e) {
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
          const r = launchPrWait(job.project, meta.prNumber, meta.prRepo, meta.prUrl);
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
        const meta = JSON.parse(job.contextMeta) as { prNumber?: number };
        if (meta.prNumber) {
          try {
            const { startMarkDod } = await import('@/lib/pipeline/start-mark-dod');
            const md = await startMarkDod(job.project);
            if (md.ok) {
              console.log(`[push→dod] PR #${meta.prNumber} DoD: ${md.verified}/${md.total} verified${md.changed ? ' (PR updated)' : ''}`);
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

  // Auto-fix-push: when a push fails because of a pre-commit / pre-push hook
  // (husky/eslint/lint-staged), spawn a Claude fix job targeting the exact
  // hook error and re-trigger the push once it finishes. Bounded by
  // MAX_FIX_PUSH_ATTEMPTS per window to prevent infinite loops on a
  // fundamentally-broken lint rule.
  if (job.kind === 'push' && job.exitCode !== 0) {
    try {
      const rawLog = readLog(job, 100_000);
      const { isHookRejection, startFixPush } = await import('@/lib/pipeline/start-fix-push');
      if (isHookRejection(rawLog)) {
        const attempts = recentFixPushCount(job.project);
        if (attempts < MAX_FIX_PUSH_ATTEMPTS) {
          const r = await startFixPush(job.project, rawLog);
          if (r.ok) {
            console.log(`[push] hook rejection → auto-fix-push ${r.jobId} (attempt ${attempts + 1}/${MAX_FIX_PUSH_ATTEMPTS})`);
            chainedNext = true;
          } else {
            console.log(`[push] hook rejection — could not start fix-push: ${r.detail}`);
          }
        } else {
          console.log(`[push] hook rejection — fix-push cap reached (${attempts}/${MAX_FIX_PUSH_ATTEMPTS}) — surfacing error`);
        }
      }
    } catch (e) {
      console.log(`[push] fix-push hook error for ${job.project}:`, e);
    }
  }

  // Chain fix-push → commit → push when Claude finishes fixing.
  if (job.kind === 'fix-push' && job.exitCode === 0) {
    try {
      const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
      const r = await startProjectCommit(job.project);
      if (r.ok) {
        console.log(`[fix-push→commit] committed ${job.project} (${r.commitSha || 'no-op'})`);
        chainedNext = true;
      } else {
        console.log(`[fix-push→commit] commit still failing for ${job.project}: ${r.detail}`);
        chainedNext = true; // Still mark as chained — commit job will finalize
      }
    } catch (e) {
      console.log(`[fix-push→commit] retry error for ${job.project}:`, e);
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
    const release = findActiveReleaseJob(job.project);
    if (release) {
      const exitCode = (job.exitCode === 0) ? 0 : 1;
      // Emit release success/fail notification before finalizing
      if (!notificationEvent) {
        notificationEvent = exitCode === 0 ? 'release_success' : 'release_fail';
      }
      await finalizeReleaseJob(release, exitCode);
    } else {
      // No active release job — still need to release the lock if this was a standalone pipeline job
      try {
        const { releaseLock } = await import('@/lib/pipeline/pipeline-lock');
        releaseLock(job.project, job.id);
      } catch {}
    }
  }

  // Send notification if an event was triggered
  if (notificationEvent) {
    try {
      const { notify } = await import('@/lib/shared/notifications');
      const logUrl = job.logPath ? `${process.env.TAMTAM_BASE_URL || 'http://localhost:1337'}/project/${encodeURIComponent(job.project)}/history` : undefined;
      const verdict = job.kind === 'review' ? getVerdict(job) : null;
      await notify({
        event: notificationEvent,
        project: job.project,
        job_id: job.id,
        status: job.exitCode === 0 ? 'success' : 'failed',
        verdict: verdict ?? undefined,
        log_url: logUrl,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error(`[notifications] failed to send notification for ${notificationEvent}:`, e);
    }
  }

  // fix-ci auto-retry: if the job crashed fast (pm2/claude boot failure) and
  // we haven't exhausted retries, kick off another attempt so the user sees
  // a spinner instead of a red exit -1.
  if (job.kind === 'fix-ci' && job.exitCode !== null && job.exitCode !== 0) {
    const { maxRetries, windowSeconds, fastCrashMs } = await getFixCiRetryConfig();
    if (maxRetries <= 0) return; // retries disabled via settings
    const durationMs = (job.finishedAt ?? 0) * 1000 - (job.startedAt ?? 0) * 1000;
    const crashedFast = durationMs > 0 && durationMs < fastCrashMs;
    const attempts = recentFixCiCount(job.project, windowSeconds);
    if (crashedFast && attempts <= maxRetries) {
      console.log(`[fix-ci] retry ${attempts}/${maxRetries} for ${job.project} — previous crashed in ${durationMs}ms`);
      const delayMs = Math.min(500 * attempts, 3000);
      setTimeout(() => {
        retryFixCi(job.project).catch((e) => {
          console.log(`[fix-ci] retry error for ${job.project}:`, e);
        });
      }, delayMs);
    } else if (attempts > maxRetries) {
      console.log(`[fix-ci] retry cap reached for ${job.project} (${attempts}/${maxRetries}) — giving up`);
    }
  }

  // Agent run failures: notify on agent run failures
  if (job.kind.startsWith('agent:') && job.exitCode !== 0) {
    try {
      const { notify } = await import('@/lib/shared/notifications');
      const agentName = job.kind.replace('agent:', '');
      const logUrl = job.logPath ? `${process.env.TAMTAM_BASE_URL || 'http://localhost:1337'}/project/${encodeURIComponent(job.project)}/history` : undefined;
      await notify({
        event: 'agent_run_fail',
        project: job.project,
        agent: agentName,
        job_id: job.id,
        status: 'failed',
        log_url: logUrl,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error(`[notifications] failed to send agent_run_fail notification:`, e);
    }
  }

  // Release-after-run: when a terminal/agent run finishes successfully, auto-trigger the release pipeline.
  if ((job.kind === 'run' || job.kind.startsWith('agent:')) && job.exitCode === 0) {
    try {
      const { releaseAfterRun } = await getProjectPipelineConfig(job.project);
      if (releaseAfterRun) {
        const { startRelease } = await import('@/lib/pipeline/start-release');
        const r = await startRelease(job.project);
        if (r.ok) {
          console.log(`[release-after-run] triggered release ${r.jobId} for ${job.project} after run ${job.id}`);
        } else {
          // Don't drop on the floor: queue a pending release and let the
          // pipeline-lock release hook (or `Resume jobs`) drain it. Covers
          // the "agent finishes while another release is mid-flight" race
          // and "jobs paused" race uniformly.
          const { setPendingRelease } = await import('@/lib/pipeline/pending-release');
          setPendingRelease(job.project);
          console.log(`[release-after-run] queued for ${job.project} (will drain when pipeline lock releases): ${r.detail}`);
        }
      }
    } catch (e) {
      console.log(`[release-after-run] error for ${job.project}:`, e);
    }
  }

  // Log retention: prune old log files for this project now that a new run completed.
  try {
    const { pruneProjectLogs } = await import('./retention');
    pruneProjectLogs(job.project);
  } catch (e) {
    console.error(`[retention] pruneProjectLogs failed for ${job.project}:`, e);
  }
}

async function retryFixCi(projectName: string): Promise<void> {
  // Re-invoke the fix-ci API route's logic by calling it HTTP-less. We post
  // to the same endpoint so it stays the single source of truth for the
  // "start a fix-ci" flow (prompt construction, log path, permission mode).
  const port = parseInt(process.env.PORT ?? '', 10) || 1337;
  try {
    await fetch(`http://127.0.0.1:${port}/api/projects/by-project/${encodeURIComponent(projectName)}/fix-ci`, {
      method: 'POST',
    });
  } catch (e) {
    console.log(`[fix-ci] retry fetch failed for ${projectName}:`, e);
  }
}

export async function markDone(job: JobData, exitCode: number): Promise<void> {
  // Idempotent: if already finalized, don't double-fire hooks or rewrite DB.
  if (job.finishedAt !== null) {
    await reconcileStaleRelease(job);
    return;
  }
  // Also check the DB — two concurrent probes can each hold a fresh JobData
  // instance (fetched via separate listJobs() calls), both see finishedAt ===
  // null, and both run the completion hook, producing double "release
  // finished" markers, double fix chains, and orphaned child jobs. Consult
  // the DB so the first writer wins. better-sqlite3 is synchronous so this
  // check-then-write is atomic w.r.t. the JS event loop; no await means no
  // other markDone can interleave here.
  const dbRow = db.select({ finishedAt: schema.jobs.finishedAt })
    .from(schema.jobs).where(eq(schema.jobs.id, job.id)).get();
  if (dbRow?.finishedAt != null) {
    job.finishedAt = dbRow.finishedAt; // keep in-memory object in sync
    // A concurrent markDone (e.g. another probe) finalized this job first.
    // Its completion hook may have crashed before finalizing the release
    // meta-job, leaving the pipeline UI stuck on "running". Reconcile here.
    await reconcileStaleRelease(job);
    return;
  }
  job.finishedAt = Date.now() / 1000;
  job.exitCode = exitCode;
  // Extract result metadata (tokens, duration, session) from log.
  // NOTE: we skip this for `release` meta-jobs. Their log is an aggregate of
  // child logs, so parseStreamLines would find the *child's* session_id and
  // falsely assign it to the release — later the UI would treat release +
  // review as the same session, merge them, and shrink the release's
  // apparent window (hiding commit/push from release grouping).
  const shouldExtractMetadata = job.kind !== 'release';
  const rawLog = shouldExtractMetadata ? readLog(job, 50_000) : '';
  const events = shouldExtractMetadata ? parseStreamLines(rawLog) : [];
  const doneEvent = events.find(e => e.type === 'done');
  if (doneEvent && doneEvent.type === 'done') {
    job.durationMs = doneEvent.result.duration;
    job.inputTokens = doneEvent.result.inputTokens;
    job.outputTokens = doneEvent.result.outputTokens;
    job.cacheReadTokens = doneEvent.result.cacheReadTokens;
    job.cacheCreateTokens = doneEvent.result.cacheCreateTokens;
    job.sessionId = doneEvent.result.sessionId;
    job.model = doneEvent.result.model ?? null;
    job.costUsd = costUsd({
      inputTokens: job.inputTokens,
      outputTokens: job.outputTokens,
      cacheReadTokens: job.cacheReadTokens,
      cacheCreateTokens: job.cacheCreateTokens,
    });
    // Claude completed successfully — override pm2's exit code. Claude CLI
    // frequently hangs for a few seconds after flushing its final result
    // event (flushing stdio, tearing down child processes) and gets killed
    // by pm2's hard-timeout or our SIGKILL fallback, which makes pm2 report
    // exit -1 / 137. If the stream-json result line says is_error=false,
    // the logical outcome was a clean finish — trust that over pm2's code.
    const isClaudeKind = (
      job.kind === 'run' ||
      job.kind === 'review' ||
      job.kind === 'fix' ||
      job.kind === 'fix-ci' ||
      job.kind === 'fix-push' ||
      job.kind.startsWith('agent:')
    );
    if (isClaudeKind && !doneEvent.result.error && exitCode !== 0) {
      console.log(`[job ${job.id}] claude result present (is_error=false) but pm2 reported exit ${exitCode}; overriding to 0`);
      job.exitCode = 0;
    }
    // Opposite direction: claude emitted a result with is_error=true (e.g. 404
    // on an unavailable model). probeJobStatus calls markDone(job, 0) for any
    // terminal result line, and pm2's exit_code may also be 0 if the wrapper
    // swallowed it — but the logical outcome was a failure, so reflect that.
    if (isClaudeKind && doneEvent.result.error && job.exitCode === 0) {
      console.log(`[job ${job.id}] claude result present (is_error=true) but exit code is 0; overriding to 1`);
      job.exitCode = 1;
    }
  }
  saveToDb(job);
  try {
    db.delete(schema.ghIssuesCache).where(eq(schema.ghIssuesCache.project, job.project)).run();
  } catch {}
  await runCompletionHooks(job);
  // Clean up PM2 process now that it's saved to DB
  try {
    const { deleteJob } = await import('@/lib/jobs/pm2-jobs');
    await deleteJob(job.id);
  } catch {}
  // Fallback: explicitly SIGKILL the bash wrapper and any children in case
  // Claude CLI hung and escaped pm2's tree-kill.
  // Skip for inline kinds (push, commit) whose job.pid IS the server's own
  // process.pid — killing it would crash TamTam and cascade -1 exits onto
  // every other in-flight job. mark-dod and pr-wait already avoid this by
  // using pid=0; push/commit use process.pid for restart detection instead.
  const isInlineServerKind = job.kind === 'push' || job.kind === 'commit';
  if (job.pid > 0 && !isInlineServerKind) {
    try {
      const { exec } = await import('@/lib/shared/shell');
      const { stdout } = await exec('pgrep', ['-P', String(job.pid)], { timeout: 2000 });
      const children = stdout.split('\n').map(s => s.trim()).filter(Boolean).map(Number);
      const pids = [job.pid, ...children];
      const alive: number[] = [];
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
          alive.push(pid);
        } catch {}
      }
      if (alive.length > 0) {
        console.log(`[job ${job.id}] force-killed hung process(es) after completion: ${alive.join(', ')}`);
      }
    } catch {}
  }
}

