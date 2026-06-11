import { eq } from 'drizzle-orm';
import { readFileSync } from 'fs';
import { db, schema } from '@/lib/db';
import { findingsIdentity, extractFindingIds, extractFixClaims } from '@/lib/pipeline/review-contract';
import { getStepWindowSeconds } from '@/lib/pipeline/recovery-budget';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import { getJobKind, isAgentJobKind } from '@/lib/jobs/kinds';
import type { JobData } from '@/lib/jobs/types';
import { getVerdict, readParsedLog } from './verdict';
import { listJobs, getJob, updateJob } from './storage';

export type ProjectPipelineConfig = {
  autoCommitEnabled: boolean;
  autoPushEnabled: boolean;
  releaseAfterRun: boolean;
  autoPrMergeEnabled: boolean;
};

// Pipeline child kinds that belong to a release meta-job. Used to silence
// successful child notifications and to identify jobs owned by release
// orchestration rather than interactive terminal handling.
export const PIPELINE_STEP_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'mark-dod', 'soak']);

export async function getProjectPipelineConfig(projectName: string): Promise<ProjectPipelineConfig> {
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

export async function stopProjectDevServerIfIdle(projectName: string): Promise<void> {
  try {
    const { hasActiveWorkForProject } = await import('@/lib/dev-server/active-work');
    if (await hasActiveWorkForProject(projectName)) return;

    const rows = await db.select().from(schema.projects).where(eq(schema.projects.name, projectName)).limit(1);
    const row = rows[0];
    if (!row?.devServerStartCommand) return;

    const { stopDevServer } = await import('@/lib/dev-server/lifecycle');
    await stopDevServer(projectName, {
      stopCommand: row.devServerStopCommand ?? null,
      cwd: row.path,
    });
  } catch (e) {
    console.warn(`[dev-server] release-end stop failed for ${projectName}:`, e);
  }
}

// Wrap plain text as a stream_event NDJSON line so it is picked up by
// readParsedLog() and visible to the fix agent reading the review log.
export function toStreamTextLine(text: string): string {
  const event = {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  };
  return JSON.stringify(event) + '\n';
}

// Build synthetic findings block for unverified acceptance criteria so the
// fix agent can read them from the review log and knows what to implement.
export function buildUnverifiedCriteriaFindings(unverified: { text: string }[]): string {
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

export function reviewSourceType(job: Pick<JobData, 'contextMeta'>): string | null {
  if (!job.contextMeta) return null;
  try {
    const meta = JSON.parse(job.contextMeta) as { sourceType?: unknown };
    return typeof meta.sourceType === 'string' ? meta.sourceType : null;
  } catch {
    return null;
  }
}

function stepWindowSeconds(): number { return getStepWindowSeconds(); }

// fix-ci fast-crash auto-retry constants. Only crash-fast failures (the
// fix-ci job died in under FIX_CI_FAST_CRASH_MS) are retried so real
// errors still surface. Kept finite even when `fix_max_iterations = 0`
// so a permanently broken fix-ci environment can't loop forever — same
// rationale as the push-hook rejection cap.
const FIX_CI_MAX_RETRIES = 2;
const FIX_CI_RETRY_WINDOW_SECONDS = 120;
const FIX_CI_FAST_CRASH_MS = 5000;

export function getFixCiRetryConfig(): { maxRetries: number; windowSeconds: number; fastCrashMs: number } {
  return { maxRetries: FIX_CI_MAX_RETRIES, windowSeconds: FIX_CI_RETRY_WINDOW_SECONDS, fastCrashMs: FIX_CI_FAST_CRASH_MS };
}

export function recentFixCiCount(projectName: string, windowSeconds: number): number {
  const cutoff = Date.now() / 1000 - windowSeconds;
  return listJobs().filter(
    (j) => j.project === projectName && j.kind === 'fix-ci' && j.startedAt >= cutoff
  ).length;
}

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

export function persistReleaseStopReason(release: JobData, stopReason: string): void {
  const meta = parseJsonObject(release.contextMeta);
  meta.releaseStopReason = stopReason;
  release.contextMeta = JSON.stringify(meta);
  updateJob(release);
}

export function recentFixFromPushCount(projectName: string): number {
  const cutoff = Date.now() / 1000 - stepWindowSeconds();
  // After fix-push was unified into the generic fix kind, a "fix from push"
  // is identified by parentJobId pointing at a push job within the window.
  return listJobs().filter((j) => {
    if (j.project !== projectName || j.kind !== 'fix') return false;
    if (j.startedAt < cutoff) return false;
    if (j.finishedAt === null) return false;
    if (!j.parentJobId) return false;
    const parent = getJob(j.parentJobId);
    return parent?.kind === 'push';
  }).length;
}

// Count occurrences of a verification step in the current pipeline run.
// The pipeline cap applies to verification rounds (test, review, commit,
// push), not fixes — fixes are unbounded so a final fix always lands, but
// the next verification step is what closes the loop and counts toward the
// budget. When the calling job is part of a release (has a `releaseId`),
// only count steps inside that same release — a leftover loop from an
// earlier release shouldn't eat this release's budget. Falls back to the
// 30-min window for ad-hoc steps outside any release.
export function recentStepCount(projectName: string, kind: string, currentJob?: JobData): number {
  const all = listJobs().filter(
    (j) => j.project === projectName && j.kind === kind && j.finishedAt !== null
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
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[\s]*[-*•]\s+/gm, '')
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  // Cheap non-crypto hash; we only need equality, not security.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

export function pipelineExitCodeForStep(job: JobData): number {
  if (job.exitCode !== 0) return 1;
  if (job.kind === 'review') {
    const verdict = getVerdict(job);
    if (verdict && verdict !== 'LGTM') return 1;
    if (!verdict) return 1;
  }
  return 0;
}

export function noteReleaseStop(reason: string): void {
  console.log(`[release] ${reason}`);
}

export async function notifyReleaseAborted(release: JobData): Promise<void> {
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
export function findLatestReviewForRelease(currentJob: JobData): JobData | null {
  const releaseId = currentJob.releaseId;
  const project = currentJob.project;
  let latest: JobData | null = null;
  for (const job of listJobs()) {
    if (job.project !== project || job.kind !== 'review') continue;
    if (releaseId && job.releaseId !== releaseId) continue;
    if (!latest || job.startedAt > latest.startedAt) {
      latest = job;
    }
  }
  return latest;
}

// Try the new "ship-anyway + file issue" path. On success, chain to a commit
// step. On failure, return false so the caller falls through to the legacy
// abort. The notification event is preserved either way so operators still
// see fix_loop_exhausted in their feed.
export async function tryReviewExhaustionFallback(
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

export function isDoNotShipReview(job: JobData): boolean {
  return job.kind === 'review' && getVerdict(job) === 'DO NOT SHIP';
}

// Decide whether a finished job should be auto-marked "seen" so the
// notification bell only highlights things that need a human. Failures and
// review verdicts that block the pipeline always stay unseen; successful
// pipeline children, LGTM reviews, and no-op agent runs are silenced.
export function shouldAutoMarkSeen(job: JobData): boolean {
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
export function reviewIsStuck(currentReview: JobData): boolean {
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
export function fixContradictsReview(currentReview: JobData): { stuck: boolean; ids: string[] } {
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

export function appendToReleaseLog(release: JobData, kind: string, job: JobData, extra?: string): void {
  if (!release.logPath) return;
  try {
    const header = `\n\n=== ${kind} (${job.id}) — started ${new Date((job.startedAt || 0) * 1000).toISOString()} — exit ${job.exitCode ?? '?'} ===\n`;
    let body = '';
    if (job.logPath) {
      // Skip the existsSync precheck — readFileSync throws ENOENT and the
      // catch swallows it, same outcome with one fewer syscall + no TOCTOU.
      try { body = readFileSync(/*turbopackIgnore: true*/ job.logPath, 'utf-8'); } catch {}
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

export function findLinkedActiveReleaseJob(job: JobData): JobData | null {
  const releaseId = linkedReleaseId(job);
  if (!releaseId) return null;
  const release = getJob(releaseId);
  if (!release || release.project !== job.project || release.kind !== 'release' || release.finishedAt !== null) {
    return null;
  }
  return release;
}
