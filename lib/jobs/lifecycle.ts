import { eq } from 'drizzle-orm';
import { existsSync, readFileSync } from 'fs';
import { db, schema } from '@/lib/db';
import { markReviewed, setReviewedRef, getCurrentBranch } from '@/lib/git/git-utils';
import { parseStreamLines } from './claude-stream-parser';
import { costUsd } from '@/lib/shared/usage-pricing';
import { getVerdict, readLog, readParsedLog } from './verdict';
import {
  saveToDb,
  listJobs,
  getJob,
  persistVerdict,
  updateJob,
} from './storage';
import { parentContext } from './parent-context';
import type { JobData } from './types';
import { findingsIdentity, extractFindingIds, extractFixClaims } from '@/lib/pipeline/review-contract';
import { hasFreshLgtm, hasLocalCommitsAhead } from '@/lib/pipeline/release-state';
import {
  buildReleaseStepChain,
  getEffectiveReleaseChainTail,
  RESUMABLE_RELEASE_STEP_KINDS,
} from '@/lib/pipeline/release-chain';
import {
  getFixPushAttemptCap,
  getMaxStepIterations,
  getReviewFixMaxIterations,
  getStepWindowSeconds,
} from '@/lib/pipeline/recovery-budget';
import {
  findLatestIssueRunContext,
  findReleaseScopedIssueContext,
  parsePrContextMeta,
} from '@/lib/pipeline/release-context';
import { getJobKind, isAgentJobKind, isClaudeBackedJobKind } from '@/lib/jobs/kinds';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';

async function getProjectPipelineConfig(projectName: string): Promise<{ autoCommitEnabled: boolean; autoPushEnabled: boolean; releaseAfterRun: boolean; autoPrMergeEnabled: boolean }> {
  try {
    const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
    const cfg = await getProjectTestConfig(projectName);
    return {
      autoCommitEnabled: !!cfg?.autoCommitEnabled,
      autoPushEnabled: !!cfg?.autoPushEnabled,
      // Default OFF: release-after-run is an explicit per-project opt-in.
      // Keep the lifecycle hook aligned with the schema, config route, and
      // scheduling helper so background jobs do not infer a release unless
      // the project row explicitly enables it.
      releaseAfterRun: cfg?.releaseAfterRun ?? false,
      autoPrMergeEnabled: !!cfg?.autoPrMergeEnabled,
    };
  } catch {
    return { autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false, autoPrMergeEnabled: false };
  }
}

// Wrap plain text as a stream_event NDJSON line so it is picked up by
// readParsedLog() and visible to the fix agent reading the review log.
function toStreamTextLine(text: string): string {
  const event = {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  };
  return JSON.stringify(event) + '\n';
}

// Build synthetic findings block for unverified acceptance criteria so the
// fix agent can read them from the review log and knows what to implement.
function buildUnverifiedCriteriaFindings(unverified: { text: string }[]): string {
  const findingLines = unverified.map((c, i) =>
    `- Finding ID: unverified-criterion-${i + 1}\n` +
    `  Severity: high\n` +
    `  Root cause: Acceptance criterion not yet implemented: ${c.text}\n` +
    `  Affected paths: (implement in the relevant code; see linked issue for details)\n` +
    `  Required fix: Implement the following acceptance criterion: ${c.text}\n` +
    `  Required tests: Add tests that verify the criterion is satisfied\n` +
    `  Verification: Re-run review; ## Verified criteria must mark this [x]`
  ).join('\n\n');
  return (
    '\n\nFindings (from unverified acceptance criteria):\n' +
    findingLines +
    '\n\nVerdict: NEEDS ATTENTION\n'
  );
}

function reviewSourceType(job: Pick<JobData, 'contextMeta'>): string | null {
  if (!job.contextMeta) return null;
  try {
    const meta = JSON.parse(job.contextMeta) as { sourceType?: unknown };
    return typeof meta.sourceType === 'string' ? meta.sourceType : null;
  } catch {
    return null;
  }
}

// Cap runaway review→fix→review loops when auto-push is on. The shared helper
// keeps lifecycle enforcement, stats snapshots, and docs on the same contract.
// Read live each time so the user can tune `review_fix_max_iterations` in
// Settings → Pipeline without restarting the server.
function maxStepIterations(): number { return getMaxStepIterations(); }
function reviewFixMaxIterations(): number { return getReviewFixMaxIterations(); }
function stepWindowSeconds(): number { return getStepWindowSeconds(); }
// fix-ci fast-crash auto-retry constants. Only crash-fast failures are retried
// so real errors still surface. These were once user-tunable settings; the
// values were never meaningful to operators and have been folded back into
// hardcoded defaults to keep the Settings UI focused on the cap that matters
// (review_fix_max_iterations).
const FIX_CI_MAX_RETRIES = 2;
const FIX_CI_RETRY_WINDOW_SECONDS = 120;
const FIX_CI_FAST_CRASH_MS = 5000;
function getFixCiRetryConfig(): { maxRetries: number; windowSeconds: number; fastCrashMs: number } {
  return { maxRetries: FIX_CI_MAX_RETRIES, windowSeconds: FIX_CI_RETRY_WINDOW_SECONDS, fastCrashMs: FIX_CI_FAST_CRASH_MS };
}

function recentFixCiCount(projectName: string, windowSeconds: number): number {
  const cutoff = Date.now() / 1000 - windowSeconds;
  return listJobs().filter(
    (j) => j.project === projectName && j.kind === 'fix-ci' && j.startedAt >= cutoff
  ).length;
}

// Cap auto-fix-push retries so a stubbornly-broken lint rule can't spin
// Claude in a loop. Same 30min window as review-fix for consistency.
const MAX_FIX_PUSH_ATTEMPTS = getFixPushAttemptCap();

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function persistReleaseStopReason(release: JobData, stopReason: string): void {
  const meta = parseJsonObject(release.contextMeta);
  meta.releaseStopReason = stopReason;
  release.contextMeta = JSON.stringify(meta);
  updateJob(release);
}

function recentFixPushCount(projectName: string): number {
  const cutoff = Date.now() / 1000 - stepWindowSeconds();
  return listJobs().filter(
    (j) => j.project === projectName && j.kind === 'fix-push' && j.startedAt >= cutoff
  ).length;
}

// Count occurrences of a verification step in the current pipeline run.
// The pipeline cap applies to verification rounds (test, review, commit,
// push), not fixes — fixes are unbounded so a final fix always lands, but
// the next verification step is what closes the loop and counts toward the
// budget. When the calling job is part of a release (has a `releaseId`),
// only count steps inside that same release — a leftover loop from an
// earlier release shouldn't eat this release's budget. Falls back to the
// 30-min window for ad-hoc steps outside any release.
function recentStepCount(projectName: string, kind: string, currentJob?: JobData): number {
  const all = listJobs().filter(
    (j) => j.project === projectName && j.kind === kind
  );
  if (currentJob?.releaseId) {
    return all.filter((j) => j.releaseId === currentJob.releaseId).length;
  }
  const cutoff = Date.now() / 1000 - stepWindowSeconds();
  return all.filter((j) => j.startedAt >= cutoff).length;
}

// Build a stable fingerprint of a review's findings list so we can detect
// stuck-in-place fix loops. We strip whitespace, list bullets, code fences,
// and the verdict line itself — only the *content* of the findings should
// drive the hash, not formatting churn.
function findingsFingerprint(reviewLogText: string): string {
  const structured = findingsIdentity(reviewLogText);
  if (structured) return `ids:${structured}`;
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

function pipelineExitCodeForStep(job: JobData): number {
  if (job.exitCode !== 0) return 1;
  if (job.kind === 'review') {
    const verdict = getVerdict(job);
    if (verdict && verdict !== 'LGTM') return 1;
    if (!verdict) return 1;
  }
  return 0;
}

function noteReleaseStop(reason: string): void {
  console.log(`[release] ${reason}`);
}

async function notifyReleaseAborted(release: JobData): Promise<void> {
  try {
    const { notify } = await import('@/lib/shared/notifications');
    await notify({
      event: 'release_aborted',
      project: release.project,
      job_id: release.id,
      status: 'failed',
      log_url: `${process.env.TAMTAM_BASE_URL || 'http://localhost:1337'}/project/${encodeURIComponent(release.project)}/history`,
      timestamp: Date.now(),
    });
  } catch (e) {
    console.error(`[notifications] failed to send notification for release_aborted:`, e);
  }
}

// Find the most recent completed review job in the same release window so the
// review-cap fallback can file an issue with that review's findings — not the
// fix job that triggered the cap check.
function findLatestReviewForRelease(currentJob: JobData): JobData | null {
  const releaseId = currentJob.releaseId;
  const project = currentJob.project;
  const reviews = listJobs()
    .filter((j) => j.project === project && j.kind === 'review' && (releaseId ? j.releaseId === releaseId : true))
    .sort((a, b) => b.startedAt - a.startedAt);
  return reviews[0] ?? null;
}

// Try the new "ship-anyway + file issue" path. On success, chain to a commit
// step. On failure, return false so the caller falls through to the legacy
// abort. The notification event is preserved either way so operators still
// see fix_loop_exhausted in their feed.
async function tryReviewExhaustionFallback(
  reviewJob: JobData,
  reason: 'review-cap' | 'review-stuck' | 'fix-contradicts-review',
): Promise<{ chainedNext: boolean; releaseStopReason: string | null; forcedReleaseExitCode: number | null }> {
  try {
    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const fb = await fileReviewExhaustionIssue(reviewJob);
    if (!fb.ok) {
      console.log(`[release] exhaustion fallback could not file issue for ${reviewJob.project}: ${fb.error}`);
      return { chainedNext: false, releaseStopReason: null, forcedReleaseExitCode: null };
    }
    // `reason` is kept on the function signature for the caller-side console
    // log; it is intentionally not passed into the issue body. See
    // review-exhaustion-fallback.ts for why invocation metadata is omitted.
    console.log(`[release] review exhaustion (${reason}) → filed issue #${fb.issueNumber} ${fb.issueUrl}; chaining to commit`);
    const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
    const r = await startProjectCommit(reviewJob.project);
    if (r.ok) {
      return { chainedNext: true, releaseStopReason: null, forcedReleaseExitCode: null };
    }
    const stop = `commit failed after exhaustion fallback for ${reviewJob.project}: ${r.detail}`;
    noteReleaseStop(stop);
    return { chainedNext: false, releaseStopReason: stop, forcedReleaseExitCode: 1 };
  } catch (e) {
    console.log(`[release] exhaustion fallback errored for ${reviewJob.project}:`, e);
    return { chainedNext: false, releaseStopReason: null, forcedReleaseExitCode: null };
  }
}

function isDoNotShipReview(job: JobData): boolean {
  return job.kind === 'review' && getVerdict(job) === 'DO NOT SHIP';
}

// Decide whether a finished job should be auto-marked "seen" so the
// notification bell only highlights things that need a human. Failures and
// review verdicts that block the pipeline always stay unseen; successful
// pipeline children, LGTM reviews, and no-op agent runs are silenced.
function shouldAutoMarkSeen(job: JobData): boolean {
  if (job.exitCode !== 0) return false;
  const kind = getJobKind(job.kind);
  // Release meta-job is the entry point users click into — keep it visible.
  if (kind === 'release') return false;
  // Interactive terminal sessions: user explicitly started them.
  if (kind === 'run') return false;
  if (kind === 'review') {
    const verdict = getVerdict(job);
    return verdict === 'LGTM';
  }
  if (isAgentJobKind(kind)) {
    // No-op agent runs (explicit empty modifiedFiles) are not actionable for
    // the user. Missing metadata means report extraction failed, so keep the
    // run visible for inspection.
    if (job.modifiedFiles == null) return false;
    try {
      const files = JSON.parse(job.modifiedFiles) as unknown[];
      return Array.isArray(files) && files.length === 0;
    } catch {
      return false;
    }
  }
  // Successful pipeline children — silenced; the release meta-job remains.
  return PIPELINE_STEP_KINDS.has(kind);
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
    const cur = findingsFingerprint(readParsedLog(currentReview));
    const old = findingsFingerprint(readParsedLog(prev));
    return cur === old && cur.length > 1;
  } catch {
    return false;
  }
}

// True if the most recent fix in the same release claimed `Status: fixed`
// for one or more Finding IDs that the current review is still flagging.
// Catches the case where reviewer and fixer disagree on whether a finding
// is closed — running another fix iteration won't help.
function fixContradictsReview(currentReview: JobData): { stuck: boolean; ids: string[] } {
  if (!currentReview.releaseId) return { stuck: false, ids: [] };
  const fixes = listJobs()
    .filter(j =>
      j.project === currentReview.project &&
      j.kind === 'fix' &&
      j.releaseId === currentReview.releaseId &&
      j.exitCode === 0 &&
      j.startedAt < currentReview.startedAt
    )
    .sort((a, b) => b.startedAt - a.startedAt);
  if (fixes.length === 0) return { stuck: false, ids: [] };
  const fixJob = fixes[0];
  try {
    const claimedFixed = new Set(
      extractFixClaims(readParsedLog(fixJob))
        .filter(c => c.status === 'fixed')
        .map(c => c.id)
    );
    if (claimedFixed.size === 0) return { stuck: false, ids: [] };
    const stillFlagged = extractFindingIds(readParsedLog(currentReview));
    const overlap = stillFlagged.filter(id => claimedFixed.has(id));
    if (overlap.length === 0) return { stuck: false, ids: [] };
    return { stuck: true, ids: overlap };
  } catch {
    return { stuck: false, ids: [] };
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
    appendRedactedFileSync(release.logPath, header + body + (extra ? `\n${extra}\n` : ''));
  } catch {}
}

function linkedReleaseId(job: JobData): string | null {
  if (job.releaseId) return job.releaseId;
  const seen = new Set<string>();
  let parentJobId = job.parentJobId ?? null;
  while (parentJobId && !seen.has(parentJobId)) {
    seen.add(parentJobId);
    const parent = getJob(parentJobId);
    if (!parent || parent.project !== job.project) return null;
    if (parent.kind === 'release') return parent.id;
    if (parent.releaseId) return parent.releaseId;
    parentJobId = parent.parentJobId ?? null;
  }
  return null;
}

function findLinkedActiveReleaseJob(job: JobData): JobData | null {
  const releaseId = linkedReleaseId(job);
  if (!releaseId) return null;
  const release = getJob(releaseId);
  if (!release || release.project !== job.project || release.kind !== 'release' || release.finishedAt !== null) {
    return null;
  }
  return release;
}

// Safety net: if the given job is a pipeline step, make sure the active
// release for its project eventually gets finalized. The normal path is
// via runCompletionHooks, but races (concurrent probes, a throw mid-hook)
// can leave the release stranded with all its children already done. This
// runs cheaply on every markDone call and only acts when the release has
// no running children and its most recent child finished long enough ago
// that we're confident nothing else is about to chain.
export const PIPELINE_STEP_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'pr-wait', 'mark-dod']);
const RELEASE_RECONCILE_GRACE_MS = 5_000;

// Steps from which the pipeline is expected to chain to another step when
// exit 0. If the chain ends at one of these and we're past the grace window,
// the completion hook never successfully ran (server restart, hook crash).
// We re-fire it in `reconcileStaleRelease` so the pipeline picks up where
// it stalled instead of being silently finalized as success.
const EXPECTED_CHAIN_KINDS = RESUMABLE_RELEASE_STEP_KINDS;

// Per (release, lastStep) re-fire attempt counter — if a re-fire still
// produces no chain after this many attempts, fall through to the original
// finalize-as-success behavior. Keeps a permanently-stuck step from looping
// forever across probe sweeps.
const MAX_RECONCILE_REFIRES = 2;
const reconcileRefireAttempts = new Map<string, number>();

export async function reconcileStaleRelease(job: JobData): Promise<void> {
  if (!PIPELINE_STEP_KINDS.has(job.kind)) return;
  const release = findLinkedActiveReleaseJob(job);
  if (!release) return;
  const now = Date.now() / 1000;
  const releaseStart = release.startedAt || 0;
  // Candidate children: pipeline-step jobs for this project that started at
  // or after the release. Sorted by startedAt so we can walk the chain.
  const candidates = listJobs()
    .filter((j) => j.project === release.project
      && PIPELINE_STEP_KINDS.has(j.kind)
      && linkedReleaseId(j) === release.id
      && (j.startedAt || 0) >= releaseStart - 1)
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const chain = buildReleaseStepChain(release, candidates);
  let edge = releaseStart;
  for (const c of chain) {
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
    const allRows = await db
      .select({ id: schema.jobs.id, kind: schema.jobs.kind, startedAt: schema.jobs.startedAt, finishedAt: schema.jobs.finishedAt })
      .from(schema.jobs)
      .where(eq(schema.jobs.project, release.project));
    const stillRunning = allRows.filter(r =>
      PIPELINE_STEP_KINDS.has(r.kind)
      && r.finishedAt == null
      && (r.startedAt ?? 0) >= releaseStart - 1,
    );
    if (stillRunning.length > 0) return;
  } catch {
    /* DB error → fall through; better to potentially over-finalize than to
       leave the release "running" forever if the DB is unreachable. */
  }
  if (release.abortedAt != null) {
    try {
      await finalizeAbortedRelease(release);
      await notifyReleaseAborted(release);
      console.log(`[release] reconciled aborted release ${release.id} (${job.project})`);
    } catch (e) {
      console.log(`[release] aborted-release reconciler failed for ${release.id}:`, e);
    }
    return;
  }

  // Detect "incomplete pipeline": the chain ends at a step that should have
  // chained to another step (test→review/commit/push, fix→test, review→commit/fix,
  // commit→push) but no successor exists. This happens when the completion hook
  // is interrupted — most often by a server rebuild that kills the Node process
  // between markDone() and runCompletionHooks() persisting the next step. The
  // old behavior was to silently finalize as success, leaving releases marked
  // "done" but never committed/pushed/merged.
  //
  // Recovery: re-fire the completion hook for the last step. Hooks are designed
  // to be idempotent (they re-check git state and pipeline locks before
  // spawning), so re-running them either kicks off the missing step (chain
  // alive again) or naturally finalizes the release if there really is nothing
  // to do.
  const lastStep = getEffectiveReleaseChainTail(chain);
  if (!lastStep) return;
  // Stuck signature: the LAST step ended exit 0 and is one from which the
  // pipeline expects to chain further. Earlier failures in the chain are
  // part of normal recovery (test fails → fix → test passes); they don't
  // disqualify. Only the final step's outcome matters for "did the chain
  // get cut short".
  const lastStepLooksStuck = lastStep.exitCode === 0 && EXPECTED_CHAIN_KINDS.has(lastStep.kind);
  const refireKey = `${release.id}:${lastStep.id}`;
  if (
    lastStepLooksStuck &&
    (reconcileRefireAttempts.get(refireKey) ?? 0) < MAX_RECONCILE_REFIRES
  ) {
    const attempt = (reconcileRefireAttempts.get(refireKey) ?? 0) + 1;
    reconcileRefireAttempts.set(refireKey, attempt);
    console.log(
      `[release] reconciler detected incomplete pipeline ${release.id} (${job.project}) — last step ${lastStep.kind} ${lastStep.id} exited 0 but did not chain; re-firing completion hooks (attempt ${attempt}/${MAX_RECONCILE_REFIRES})`
    );
    try {
      await runCompletionHooks(lastStep);
    } catch (e) {
      console.log(`[release] re-fired completion hooks failed for ${lastStep.id}:`, e);
    }
    // Whether the hook chained a new step (next reconcile picks up the new
    // chain) or finalized the release itself, return — do not also call
    // finalizeReleaseJob below, that would double-finalize on success.
    return;
  }

  const worstExit = chain.reduce((acc, c) => Math.max(acc, pipelineExitCodeForStep(c)), 0);
  // If we hit the re-fire cap on a still-non-chaining step, finalize as
  // failure so the user sees the release didn't ship instead of a misleading
  // green. Stop reason is recorded for the trace UI.
  let stopReason: string | null = null;
  let finalExit = worstExit;
  if (
    lastStepLooksStuck &&
    (reconcileRefireAttempts.get(refireKey) ?? 0) >= MAX_RECONCILE_REFIRES
  ) {
    stopReason = `pipeline incomplete: stuck at ${lastStep.kind} ${lastStep.id} — completion hook never chained the next step (likely interrupted by a server restart). Re-fire attempts exhausted.`;
    finalExit = 1;
    persistReleaseStopReason(release, stopReason);
    if (release.logPath) {
      try { appendRedactedFileSync(release.logPath, `\n# release stopped — ${stopReason}\n`); } catch {}
    }
    reconcileRefireAttempts.delete(refireKey);
  }
  try {
    await finalizeReleaseJob(release, finalExit);
    console.log(`[release] reconciled stale release ${release.id} (${job.project}) — ${chain.length} chained step${chain.length === 1 ? '' : 's'}, exit ${finalExit}${stopReason ? ` (${stopReason})` : ''}`);
  } catch (e) {
    console.log(`[release] reconciler failed for ${release.id}:`, e);
  }
}

export async function finalizeReleaseJob(release: JobData, exitCode: number): Promise<void> {
  if (release.finishedAt !== null) return;
  try {
    if (release.logPath) {
      appendRedactedFileSync(release.logPath, `\n# release finished — exit ${exitCode} — ${new Date().toISOString()}\n`);
    }
  } catch {}
  await markDone(release, exitCode);
  // Release the pipeline lock
  try {
    const { releaseLock } = await import('@/lib/pipeline/pipeline-lock');
    await releaseLock(release.project, release.id);
  } catch {}
}

export async function finalizeAbortedRelease(release: JobData): Promise<void> {
  if (release.abortedAt == null) {
    release.abortedAt = Date.now() / 1000;
    updateJob(release);
  }
  await finalizeReleaseJob(release, -3);
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
    const release = findLinkedActiveReleaseJob(job);
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
      if (job.finishedAt !== null && releaseForAbortCheck.finishedAt === null) {
        await finalizeAbortedRelease(releaseForAbortCheck);
        await notifyReleaseAborted(releaseForAbortCheck);
      }
      return;
    }
  }

  // Workflow-driven release short-circuit: when the release meta-job is
  // marked as workflow-driven, the orchestrator workflow (see
  // lib/workflows/release-orchestrator.ts) is responsible for chaining
  // downstream steps. Skip the hook-driven chain to avoid double-dispatch.
  // The abort + release-log-streaming paths above still run because they
  // are observability/cleanup, not orchestration.
  if (['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'mark-dod'].includes(job.kind) && job.releaseId) {
    const { isWorkflowDriven } = await import('@/lib/workflows/workflow-driven-flag');
    if (isWorkflowDriven(job, (id) => getJob(id))) {
      console.log(`[release] job ${job.id} (${job.kind}) is workflow-driven — skipping hook chain`);
      return;
    }
  }

  // Auto-chain gate: the current step's results are already persisted; if a
  // hard gate is closed (pause, 5h quota, credits), don't kick off the next one.
  if (['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'mark-dod'].includes(job.kind)) {
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
    // Release pipeline: review LGTM → push; NEEDS ATTENTION/DO NOT SHIP → fix
    try {
      const inRelease = !!findLinkedActiveReleaseJob(job);
      const pipelineCfg = await getProjectPipelineConfig(job.project);
      if (job.exitCode === 0 && (inRelease || pipelineCfg.autoPushEnabled || pipelineCfg.autoCommitEnabled)) {
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
          if (commitCount >= maxStepIterations()) {
            releaseStopReason = `commit cap reached for ${job.project} (${commitCount}/${maxStepIterations()}) — commits keep cycling, stopping`;
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
          // a fix. The cap lives on the verification side: the fix→review
          // hook counts reviews and bails before starting the (MAX+1)-th
          // review. The trailing fix may go unverified, which is the explicit
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
  }

  if (job.kind === 'fix' && job.exitCode === 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      if (!!findLinkedActiveReleaseJob(job) || autoPushEnabled || autoCommitEnabled) {
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
        const fromCommitFailure = parent?.kind === 'commit' && parent.exitCode !== null && parent.exitCode !== 0;

        if (fromCommitFailure) {
          // Symmetric to fromTestFailure: re-run the commit step that failed
          // (e.g. pre-commit hook caught a regression introduced by the
          // prior fix). Cap on number of commits so a stubbornly-failing
          // hook can't churn commit→fix→commit forever.
          const commitCount = recentStepCount(job.project, 'commit', job);
          if (commitCount >= maxStepIterations()) {
            releaseStopReason = `commit cap reached for ${job.project} (${commitCount}/${maxStepIterations()}) — commit keeps failing, stopping`;
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
        } else if (fromTestFailure) {
          // Cap on number of test runs — a persistently-broken test can't
          // churn test→fix→test→fix forever. Counts tests (the verification
          // round), not fixes; the trailing fix lands but the next test is
          // skipped once the budget is spent.
          const testCount = recentStepCount(job.project, 'test', job);
          if (testCount >= maxStepIterations()) {
            releaseStopReason = `test cap reached for ${job.project} (${testCount}/${maxStepIterations()}) — tests still need verification`;
            noteReleaseStop(releaseStopReason);
            notificationEvent = 'fix_loop_exhausted';
            forcedReleaseExitCode = 1;
          } else {
            const { startProjectTest } = await import('@/lib/pipeline/start-test');
            const r = await startProjectTest(job.project);
            if (r.ok) {
              console.log(`[fix→test] re-running tests after fix ${job.id} (test #${testCount + 1})`);
              chainedNext = true;
            } else {
              releaseStopReason = `skipped re-test for ${job.project}: ${r.detail}`;
              noteReleaseStop(releaseStopReason);
              forcedReleaseExitCode = 1;
            }
          }
        } else {
          // Cap on number of reviews — review loops with scope-creeping fixes
          // (each iteration finds *new* findings introduced or exposed by the
          // previous fix) can otherwise loop unbounded since `reviewIsStuck`
          // and `fixContradictsReview` only catch identical-finding repeats.
          // Count completed reviews; bail before starting review #(MAX+1).
          const reviewCount = recentStepCount(job.project, 'review', job);
          if (reviewCount >= reviewFixMaxIterations()) {
            const legacyStop = `review cap reached for ${job.project} (${reviewCount}/${reviewFixMaxIterations()}) — review keeps surfacing new findings, stopping`;
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
        if (pushCount >= maxStepIterations()) {
          releaseStopReason = `push cap reached for ${job.project} (${pushCount}/${maxStepIterations()}) — pushes keep cycling, stopping`;
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

        if (hasUncommittedChanges || hasUnpushedCommits) {
          // Review disabled → skip straight to commit (agent prompt covers review).
          const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
          const reviewDisabled = !!(await getProjectTestConfig(job.project))?.reviewDisabled;
          if (freshLgtm) {
            const pushCount = recentStepCount(job.project, 'push', job);
            if (pushCount >= maxStepIterations()) {
              releaseStopReason = `push cap reached for ${job.project} (${pushCount}/${maxStepIterations()}) — pushes keep cycling, stopping`;
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
            if (commitCount >= maxStepIterations()) {
              releaseStopReason = `commit cap reached for ${job.project} (${commitCount}/${maxStepIterations()}) — commits keep cycling, stopping`;
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

  // Test failed: kick off a fix job using the test log. The fix→review hook
  // chains back through review → commit → push. Fixes are unbounded — the
  // loop is bounded on the verification side (next test/review).
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

  // Auto-fix-push: when a push fails because of a pre-commit / pre-push hook
  // (husky/eslint/lint-staged), spawn a Claude fix job targeting the exact
  // hook error and re-trigger the push once it finishes. Bounded by
  // MAX_FIX_PUSH_ATTEMPTS per window to prevent infinite loops on a
  // fundamentally-broken lint rule.
  if (job.kind === 'push' && job.exitCode !== 0) {
    try {
      const rawLog = readLog(job, 100_000);
      const { isHookRejection, isTestFailureRejection, startFixPush } = await import('@/lib/pipeline/start-fix-push');
      if (isTestFailureRejection(rawLog)) {
        // Pre-push hook ran tests and they failed. fix-push is the wrong loop
        // here — it's tuned for lint/typecheck nits, not for diagnosing test
        // failures (especially flakes). Stop the pipeline and surface the
        // failure so a human can decide whether to skip, fix, or rerun.
        releaseStopReason = `push blocked: pre-push hook tests failed for ${job.project}`;
        noteReleaseStop(releaseStopReason);
        forcedReleaseExitCode = 1;
        console.log(`[push] pre-push tests failed for ${job.project} — not auto-retrying via fix-push`);
      } else if (isHookRejection(rawLog)) {
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
          releaseStopReason = `fix-push cap reached for ${job.project} (${attempts}/${MAX_FIX_PUSH_ATTEMPTS}) — push hook failures still need recovery`;
          noteReleaseStop(releaseStopReason);
          notificationEvent = 'fix_loop_exhausted';
          forcedReleaseExitCode = 1;
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

  // When a release meta-job itself completes (via probe, abort, or any path
  // that calls markDone directly rather than finalizeReleaseJob), ensure the
  // pipeline lock is released. finalizeReleaseJob already calls releaseLock,
  // but probeJobStatus can call markDone→runCompletionHooks directly, leaving
  // the lock orphaned. releaseLock is idempotent — calling it twice is safe.
  if (job.kind === 'release') {
    try {
      const { releaseLock } = await import('@/lib/pipeline/pipeline-lock');
      await releaseLock(job.project, job.id);
    } catch {}
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
        status: (forcedReleaseExitCode ?? pipelineExitCodeForStep(job)) === 0 ? 'success' : 'failed',
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
    const { maxRetries, windowSeconds, fastCrashMs } = getFixCiRetryConfig();
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
  if (isAgentJobKind(job.kind) && job.exitCode !== 0) {
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

  // Release-after-fix-ci: a successful CI fix has uncommitted local changes
  // (the fix-ci prompt instructs Claude not to commit). Trigger the release
  // pipeline so test → review → commit → push lands the fix and re-runs CI;
  // otherwise the user clicks "Fix CI", the change sits dirty, and broken CI
  // never recovers.
  if (job.kind === 'fix-ci' && job.exitCode === 0) {
    try {
      const { startRelease } = await import('@/lib/pipeline/start-release');
      const r = await startRelease(job.project, { queueIfBlocked: true, sourceJobId: job.id });
      if (r.ok) {
        if ('status' in r && r.status === 'queued') {
          console.log(`[release-after-fix-ci] queued release for ${job.project} after fix-ci ${job.id}`);
        } else {
          console.log(`[release-after-fix-ci] triggered release ${r.jobId} for ${job.project} after fix-ci ${job.id}`);
        }
      } else {
        const { shouldKeepPendingRelease, setPendingRelease } = await import('@/lib/pipeline/pending-release');
        if (shouldKeepPendingRelease(r)) {
          setPendingRelease(job.project);
          console.log(`[release-after-fix-ci] queued for ${job.project} (will drain when lock releases): ${r.detail}`);
        } else {
          console.log(`[release-after-fix-ci] no release for ${job.project}: ${r.detail}`);
        }
      }
    } catch (e) {
      console.log(`[release-after-fix-ci] error for ${job.project}:`, e);
    }
  }

  // Release-after-run: when a terminal/agent run finishes successfully, auto-trigger the release pipeline.
  if ((getJobKind(job.kind) === 'run' || isAgentJobKind(job.kind)) && job.exitCode === 0) {
    try {
      const { releaseAfterRun } = await getProjectPipelineConfig(job.project);
      if (releaseAfterRun) {
        const { startRelease } = await import('@/lib/pipeline/start-release');
        const r = await startRelease(job.project, { queueIfBlocked: true, sourceJobId: job.id });
        if (r.ok) {
          if ('status' in r && r.status === 'queued') {
            console.log(`[release-after-run] queued release for ${job.project} after run ${job.id}`);
          } else {
            console.log(`[release-after-run] triggered release ${r.jobId} for ${job.project} after run ${job.id}`);
          }
        } else {
          // Only queue a pending-release flag for failures that actually need
          // to wait for something (lock conflict, jobs paused, budget block,
          // explicit retryable). Non-retryable failures like "Nothing to
          // release" or "project not found" must not stamp the flag — there
          // is no future event that will drain them, so the banner sticks.
          const { shouldKeepPendingRelease, setPendingRelease } = await import('@/lib/pipeline/pending-release');
          if (shouldKeepPendingRelease(r)) {
            setPendingRelease(job.project);
            console.log(`[release-after-run] queued for ${job.project} (will drain when pipeline lock releases): ${r.detail}`);
          } else {
            console.log(`[release-after-run] no release for ${job.project}: ${r.detail}`);
          }
        }
      }
    } catch (e) {
      console.log(`[release-after-run] error for ${job.project}:`, e);
    }
  }

  // Drain the pending-agent-run queue AFTER release-after-run so a release
  // pipeline that's about to be triggered has a chance to acquire the project
  // lock first. Without this ordering the drain fires the next queued agent
  // before the release lock is held — both then run concurrently on the same
  // worktree. Once the lock is acquired (synchronously inside startRelease),
  // the agent run route routes the drained entry into the DB-backed
  // queued-agent-runs queue, which is replayed when the pipeline lock
  // releases.
  if (isAgentJobKind(job.kind)) {
    try {
      const { drainNextAgentRun } = await import('@/lib/agents/pending-agent-run');
      await drainNextAgentRun(job.project);
    } catch (e) {
      console.error(`[pending-agent-run] drain hook error for ${job.project}:`, e);
    }
  }

  // Log retention: prune old log files for this project now that a new run completed.
  try {
    const { pruneProjectLogs } = await import('./retention');
    pruneProjectLogs(job.project);
  } catch (e) {
    console.error(`[retention] pruneProjectLogs failed for ${job.project}:`, e);
  }

  try {
    const { getSettings } = await import('@/lib/shared/config');
    if (getSettings().github_board_sync_enabled) {
      const { queueJobBoardSync } = await import('@/lib/github/project-board');
      await queueJobBoardSync(job, 'finished');
    }
  } catch (e) {
    console.error(`[github-board] failed to sync finished job ${job.id}:`, e);
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
  // the DB so the first writer wins.
  const dbRows = await db.select({ finishedAt: schema.jobs.finishedAt })
    .from(schema.jobs).where(eq(schema.jobs.id, job.id)).limit(1);
  const dbRow = dbRows[0] ?? null;
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
    const isClaudeKind = isClaudeBackedJobKind(job.kind);
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
  if (isAgentJobKind(job.kind) || (job.kind === 'run' && job.ghIssueNumber != null)) {
    try {
      const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
      await finalizeAgentRunReport(job, rawLog);
    } catch (e) {
      console.log(`[job ${job.id}] failed to finalize agent run report:`, e);
    }
  }
  if (shouldAutoMarkSeen(job)) job.seen = true;
  saveToDb(job);
  void db.delete(schema.ghIssuesCache).where(eq(schema.ghIssuesCache.project, job.project)).execute().catch(() => {});
  // Wrap completion hooks so a thrown handler can't strand the release
  // meta-job in `running`. Without this, an error inside e.g. the test→fix
  // hook (dynamic import failure, helper crash) would propagate up to the
  // PM2 onExit caller, skip the finalize block below, and leave the
  // release pipeline lock held with no child running. The
  // reconcileStaleRelease call after the catch is the safety net that
  // walks the chain and finalizes the release with the worst child exit.
  try {
    await runCompletionHooks(job);
  } catch (hookErr) {
    console.error(`[markDone] completion hooks threw for ${job.id}:`, hookErr);
    try {
      await reconcileStaleRelease(job);
    } catch (reconcileErr) {
      console.error(`[markDone] reconcileStaleRelease also failed for ${job.id}:`, reconcileErr);
    }
  }
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
  // Refuse to operate on system PIDs. macOS reserves 1–99 for daemons; PID 1 is
  // launchd, whose children include every user GUI app. A bad job.pid value
  // from a corrupt DB row or a misbehaving spawner would otherwise SIGKILL
  // Finder / Dock / the running terminal — observed during a unit test that
  // accidentally passed pid=1. A legitimate tamtam-spawned process always has
  // pid > 100 in practice.
  const SAFE_PID_FLOOR = 100;
  if (job.pid > SAFE_PID_FLOOR && !isInlineServerKind) {
    try {
      const { exec } = await import('@/lib/shared/shell');
      const { stdout } = await exec('pgrep', ['-P', String(job.pid)], { timeout: 2000 });
      const children = stdout.split('\n').map(s => s.trim()).filter(Boolean).map(Number);
      const pids = [job.pid, ...children];
      const alive: number[] = [];
      for (const pid of pids) {
        if (pid <= SAFE_PID_FLOOR) continue;
        try {
          process.kill(pid, 'SIGKILL');
          alive.push(pid);
        } catch {}
      }
      if (alive.length > 0) {
        console.log(`[job ${job.id}] force-killed hung process(es) after completion: ${alive.join(', ')}`);
      }
    } catch {}
  } else if (job.pid > 0 && job.pid <= SAFE_PID_FLOOR) {
    console.warn(`[job ${job.id}] refusing to clean up suspicious pid=${job.pid} (system PID range); kind=${job.kind}`);
  }
}
