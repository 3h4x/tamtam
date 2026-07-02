import { and, eq, isNotNull } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getVerdict } from './verdict';
import { currentParent } from './parent-context';
import { getSettings } from '@/lib/shared/config';
import { extractFailureLogDetailFromTail } from '@/lib/jobs/failure-log-detail';
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes';
import type { JobData } from './types';

export { runWithParent } from './parent-context';

// In production, pin the cache on globalThis so route handlers and lifecycle
// hooks share state across Next.js's separate module realms. Without this,
// marking a job done in the lifecycle realm leaves the API-route realm's
// cache stale, so /api/jobs keeps returning status:"running" forever
// (probe.ts trusts the cached job.finishedAt for inline push/commit and
// never re-checks the DB).
//
// Tests use vi.resetModules() to get a fresh storage module per test;
// globalThis pinning would defeat that, so skip it in test runs.
type JobsCacheGlobals = { __tamtamJobsCache?: Map<string, JobData>; __tamtamJobsCacheLoaded?: boolean };
const g = globalThis as JobsCacheGlobals;
const isTestEnv = !!process.env.VITEST || process.env.NODE_ENV === 'test';
if (!isTestEnv && !g.__tamtamJobsCache) g.__tamtamJobsCache = new Map<string, JobData>();
export const jobsCache = isTestEnv ? new Map<string, JobData>() : (g.__tamtamJobsCache as Map<string, JobData>);
let loaded = false;

export async function loadFromDb(): Promise<void> {
  const isLoaded = isTestEnv ? loaded : g.__tamtamJobsCacheLoaded;
  if (isLoaded) return;
  try {
    const rows = await db.select().from(schema.jobs);
    for (const row of rows) {
      jobsCache.set(row.id, {
        id: row.id,
        project: row.project,
        kind: row.kind,
        prompt: row.prompt ?? null,
        pid: row.pid,
        logPath: row.logPath,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt ?? null,
        exitCode: row.exitCode ?? null,
        seen: row.seen ?? false,
        durationMs: row.durationMs ?? null,
        inputTokens: row.inputTokens ?? null,
        outputTokens: row.outputTokens ?? null,
        cacheReadTokens: row.cacheReadTokens ?? null,
        cacheCreateTokens: row.cacheCreateTokens ?? null,
        sessionId: row.sessionId ?? null,
        contextMeta: row.contextMeta ?? null,
        userPrompt: row.userPrompt ?? null,
        parentJobId: row.parentJobId ?? null,
        ghIssueNumber: row.ghIssueNumber ?? null,
        ghIssueRepo: row.ghIssueRepo ?? null,
        ghIssueTitle: row.ghIssueTitle ?? null,
        logPruned: row.logPruned ?? false,
        verdict: row.verdict ?? null,
        costUsd: row.costUsd ?? null,
        model: row.model ?? null,
        releaseId: row.releaseId ?? null,
        abortedAt: row.abortedAt ?? null,
        releaseDeadlineAt: row.releaseDeadlineAt ?? null,
        promptBytes: row.promptBytes ?? null,
        workSummary: row.workSummary ?? null,
        modifiedFiles: row.modifiedFiles ?? null,
        linesAdded: row.linesAdded ?? null,
        linesRemoved: row.linesRemoved ?? null,
        provider: row.provider ?? null,
        runScore: row.runScore ?? null,
        skillIds: row.skillIds ?? '[]',
      });
    }
    if (isTestEnv) loaded = true;
    else g.__tamtamJobsCacheLoaded = true;
  } catch (e) {
    console.error('Failed to load jobs from DB:', e);
  }
}

// Per-job in-flight write serialization. Without this, two back-to-back
// `saveToDb(job)` calls (e.g. `createJob` then a follow-up `updateJob` to
// stamp `logPath` after spawn) can race on the pg.Pool: the second insert
// races ahead on a different pooled connection, the first lands later, and
// the first's `onConflictDoUpdate` clobbers the second's payload with the
// stale snapshot. Symptom: `pid=0`, `logPath=NULL` in the DB even though
// the spawn succeeded and start-test wrote both fields. probe.ts then
// declares the test job dead at the 30s spawn-grace and force-marks it
// exit=-1 even though tests are still running.
//
// The chain serializes writes for the same `job.id` while leaving writes
// for different jobs free to parallelize. Stays fire-and-forget at the
// call site so existing helpers don't need to be made async.
const inFlightSaves = new Map<string, Promise<void>>();

function enqueueJobWrite(jobId: string, write: () => Promise<void>): Promise<void> {
  const prev = inFlightSaves.get(jobId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(write);
  inFlightSaves.set(jobId, next);
  return next.finally(() => {
    if (inFlightSaves.get(jobId) === next) inFlightSaves.delete(jobId);
  });
}

export async function saveToDbAsync(job: JobData): Promise<void> {
  const snapshot = { ...job };
  await enqueueJobWrite(snapshot.id, () => doSaveToDb(snapshot));
}

export function saveToDb(job: JobData): void {
  void saveToDbAsync(job);
}

/** Block until any in-flight save for this job id has flushed. Lets
 *  callers that need their write to be observable downstream (e.g.
 *  `markDone` before emitting a job_completion_events row) wait without
 *  changing the saveToDb fire-and-forget call convention. */
export async function awaitInFlightSave(jobId: string): Promise<void> {
  const p = inFlightSaves.get(jobId);
  if (p) await p;
}

function doSaveToDb(job: JobData): Promise<void> {
  return db.insert(schema.jobs)
      .values({
        id: job.id,
        project: job.project,
        kind: job.kind,
        prompt: job.prompt,
        pid: job.pid,
        logPath: job.logPath,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        exitCode: job.exitCode,
        seen: job.seen,
        durationMs: job.durationMs,
        inputTokens: job.inputTokens,
        outputTokens: job.outputTokens,
        cacheReadTokens: job.cacheReadTokens,
        cacheCreateTokens: job.cacheCreateTokens,
        sessionId: job.sessionId,
        contextMeta: job.contextMeta,
        userPrompt: job.userPrompt,
        parentJobId: job.parentJobId ?? null,
        ghIssueNumber: job.ghIssueNumber ?? null,
        ghIssueRepo: job.ghIssueRepo ?? null,
        ghIssueTitle: job.ghIssueTitle ?? null,
        logPruned: job.logPruned ?? false,
        verdict: job.verdict ?? null,
        costUsd: job.costUsd ?? null,
        model: job.model ?? null,
        releaseId: job.releaseId ?? null,
        abortedAt: job.abortedAt ?? null,
        releaseDeadlineAt: job.releaseDeadlineAt ?? null,
        promptBytes: job.promptBytes ?? null,
        workSummary: job.workSummary ?? null,
        modifiedFiles: job.modifiedFiles ?? null,
        linesAdded: job.linesAdded ?? null,
        linesRemoved: job.linesRemoved ?? null,
        provider: job.provider ?? null,
        runScore: job.runScore ?? null,
        skillIds: job.skillIds ?? '[]',
      })
      .onConflictDoUpdate({
        target: schema.jobs.id,
        set: {
          pid: job.pid,
          logPath: job.logPath,
          finishedAt: job.finishedAt,
          exitCode: job.exitCode,
          seen: job.seen,
          durationMs: job.durationMs,
          inputTokens: job.inputTokens,
          outputTokens: job.outputTokens,
          cacheReadTokens: job.cacheReadTokens,
          cacheCreateTokens: job.cacheCreateTokens,
          sessionId: job.sessionId,
          contextMeta: job.contextMeta,
          userPrompt: job.userPrompt,
          parentJobId: job.parentJobId ?? null,
          ghIssueNumber: job.ghIssueNumber ?? null,
          ghIssueRepo: job.ghIssueRepo ?? null,
          ghIssueTitle: job.ghIssueTitle ?? null,
          logPruned: job.logPruned ?? false,
          verdict: job.verdict ?? null,
          costUsd: job.costUsd ?? null,
          model: job.model ?? null,
          releaseId: job.releaseId ?? null,
          abortedAt: job.abortedAt ?? null,
          releaseDeadlineAt: job.releaseDeadlineAt ?? null,
          promptBytes: job.promptBytes ?? null,
          workSummary: job.workSummary ?? null,
          modifiedFiles: job.modifiedFiles ?? null,
          linesAdded: job.linesAdded ?? null,
          linesRemoved: job.linesRemoved ?? null,
          provider: job.provider ?? null,
          runScore: job.runScore ?? null,
          skillIds: job.skillIds ?? '[]',
        },
      })
      .execute()
      .then(() => undefined)
      .catch(e => {
        console.error(`Failed to save job ${job.id}:`, e);
      });
}

// Find the most recent in-flight release job for this project — the single
// terminal the user watches during a release. Each pipeline step appends
// its section to this job's log.
export function findActiveReleaseJob(projectName: string): JobData | null {
  let active: JobData | null = null;
  for (const job of jobsCache.values()) {
    if (job.project !== projectName || job.kind !== 'release' || job.finishedAt !== null) continue;
    if (!active || (job.startedAt || 0) > (active.startedAt || 0)) active = job;
  }
  return active;
}

export function createJob(
  project: string,
  kind: string,
  pid: number,
  logPath: string,
  prompt?: string,
  contextMeta?: string,
  userPrompt?: string,
  ghIssueNumber?: number | null,
  ghIssueRepo?: string | null,
  ghIssueTitle?: string | null,
  parentJobId?: string | null,
  provider?: string | null,
): JobData {
  let timestamp = Date.now() * 1000;
  let jobId = `${project}-${kind}-${timestamp}`;
  while (jobsCache.has(jobId)) {
    timestamp += 1;
    jobId = `${project}-${kind}-${timestamp}`;
  }
  const resolvedParentJobId = parentJobId ?? currentParent();
  let autoReleaseId: string | null = null;
  // Only jobs started from an existing parent chain inherit release scope.
  // Ambient "there happens to be an active release for this project" is not
  // strong enough: unrelated manual test/review/fix jobs must stay outside the
  // pipeline strip and release trace unless the caller explicitly starts them
  // from a release-linked parent.
  if (kind !== 'release' && resolvedParentJobId) {
    const parent = getJob(resolvedParentJobId);
    if (parent?.project === project) {
      autoReleaseId = parent.kind === 'release' ? parent.id : parent.releaseId ?? null;
    }
  }
  const job: JobData = {
    id: jobId,
    project,
    kind,
    prompt: prompt || null,
    pid,
    logPath,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    sessionId: null,
    contextMeta: contextMeta ?? null,
    userPrompt: userPrompt ?? null,
    parentJobId: resolvedParentJobId,
    ghIssueNumber: ghIssueNumber ?? null,
    ghIssueRepo: ghIssueRepo ?? null,
    ghIssueTitle: ghIssueTitle ?? null,
    releaseId: autoReleaseId,
    releaseDeadlineAt: null,
    workSummary: null,
    modifiedFiles: null,
    linesAdded: null,
    linesRemoved: null,
    provider: provider ?? null,
    runScore: null,
    skillIds: '[]',
  };
  jobsCache.set(jobId, job);
  saveToDb(job);
  let boardSyncEnabled = false;
  try { boardSyncEnabled = getSettings().github_board_sync_enabled; } catch { /* settings unavailable — skip */ }
  if (boardSyncEnabled) {
    void import('@/lib/github/project-board')
      .then(({ queueJobBoardSync }) => queueJobBoardSync(job, 'started'))
      .catch((error) => {
        console.error(`[github-board] failed to queue start sync for ${job.id}`, error);
      });
  }
  return job;
}

export function getJob(jobId: string): JobData | null {
  return jobsCache.get(jobId) ?? null;
}

// Persist verdict without a full job round-trip. Called right after a review
// finishes so the verdict survives log pruning.
export function persistVerdict(jobId: string, verdict: string): void {
  const job = jobsCache.get(jobId);
  if (job) job.verdict = verdict;
  void enqueueJobWrite(jobId, async () => {
    await db.update(schema.jobs)
      .set({ verdict })
      .where(eq(schema.jobs.id, jobId))
      .execute();
  }).catch(e => console.error(`Failed to persist verdict for ${jobId}:`, e));
}

export function listJobs(): JobData[] {
  return Array.from(jobsCache.values());
}

export function unseenFinished(): JobData[] {
  return Array.from(jobsCache.values()).filter(
    (j) => j.finishedAt !== null && !j.seen
  );
}

export function markSeen(jobId: string): boolean {
  const job = jobsCache.get(jobId);
  if (!job) return false;
  job.seen = true;
  saveToDb(job);
  return true;
}

/**
 * Bulk-mark every finished-but-unseen job as seen. Single targeted UPDATE
 * + in-memory cache mutation, instead of N upserts (one per matching row)
 * which is what the per-job `markSeen` would cost when called in a loop
 * from `mark-all-seen`. Returns the number of jobs flipped — useful for
 * route responses and tests.
 *
 * Waits behind any existing per-job save for the affected ids before the
 * bulk UPDATE. Otherwise an older queued save can commit after the bulk
 * write with `seen=false` and make cleared notifications reappear after
 * cache reload.
 */
export async function markAllUnseenFinished(): Promise<number> {
  const ids: string[] = [];
  for (const job of jobsCache.values()) {
    if (job.finishedAt !== null && !job.seen) {
      job.seen = true;
      ids.push(job.id);
    }
  }
  if (ids.length > 0) {
    await Promise.all(ids.map((id) => awaitInFlightSave(id)));
    await db.update(schema.jobs)
      .set({ seen: true })
      .where(and(isNotNull(schema.jobs.finishedAt), eq(schema.jobs.seen, false)))
      .execute();
  }
  return ids.length;
}

export function updateJob(job: JobData): void {
  // Keep the in-memory cache in sync with the DB write. Without this, an
  // `updateJob` that ran on a job object which is NOT the cached reference
  // (e.g. a pipeline phase finalizing inside the workflow runtime) persists to
  // Postgres but leaves `listJobs()` serving a stale row — reads like the inbox
  // then see `finishedAt: null` / missing `contextMeta` for a job the DB has
  // already finalized, so signals derived from finished state silently misfire.
  jobsCache.set(job.id, job);
  saveToDb(job);
}

const LIST_PROMPT_PREVIEW_BYTES = 200;
const LIST_FAILURE_DETAIL_TAIL_BYTES = 64 * 1024;
const LIST_FAILURE_DETAIL_MAX_CHARS = 2000;

function truncatePromptForList(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  if (text.length <= LIST_PROMPT_PREVIEW_BYTES) return text;
  // Encoded as a normal string suffix so existing UI truncation logic stays
  // happy. The detail endpoint still ships the full prompt.
  return text.slice(0, LIST_PROMPT_PREVIEW_BYTES - 1) + '…';
}

function truncateFailureDetailForList(text: string): string {
  if (text.length <= LIST_FAILURE_DETAIL_MAX_CHARS) return text;
  return text.slice(0, LIST_FAILURE_DETAIL_MAX_CHARS - 1) + '…';
}

function failureDetailForList(job: JobData): string | null {
  if (job.exitCode == null || job.exitCode === 0 || isCancelledExitCode(job.exitCode) || !job.logPath) {
    return null;
  }
  const detail = extractFailureLogDetailFromTail(job.logPath, LIST_FAILURE_DETAIL_TAIL_BYTES, {
    includeNonJsonDetail: true,
  });
  return detail ? truncateFailureDetailForList(detail) : null;
}

// Slim variant for the list endpoint. Drops fields no list consumer reads
// (log_path, full prompts) and trims preview text to the first 200 bytes.
// `/api/jobs/[jobId]` continues to serve the full payload for terminal
// restore and detail views.
export function jobToListDict(job: JobData): Record<string, unknown> {
  const d = jobToDict(job);
  const detail = failureDetailForList(job);
  if (detail) d.detail = detail;
  d.prompt = truncatePromptForList(job.prompt);
  d.user_prompt = truncatePromptForList(job.userPrompt);
  delete d.log_path;
  return d;
}

export function jobToDict(job: JobData): Record<string, unknown> {
  const d: Record<string, unknown> = {
    id: job.id,
    project: job.project,
    kind: job.kind,
    prompt: job.prompt,
    pid: job.pid,
    log_path: job.logPath,
    status: job.abortedAt != null ? 'aborted' : job.finishedAt !== null ? 'done' : 'running',
    aborted_at: job.abortedAt ?? null,
    exit_code: job.exitCode,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    seen: job.seen,
    duration_ms: job.durationMs,
    input_tokens: job.inputTokens,
    output_tokens: job.outputTokens,
    cache_read_tokens: job.cacheReadTokens,
    cache_create_tokens: job.cacheCreateTokens,
    session_id: job.sessionId,
    context_meta: job.contextMeta ?? null,
    user_prompt: job.userPrompt ?? null,
    cost_usd: job.costUsd ?? null,
    model: job.model ?? null,
    gh_issue_number: job.ghIssueNumber ?? null,
    gh_issue_repo: job.ghIssueRepo ?? null,
    gh_issue_title: job.ghIssueTitle ?? null,
  };
  d.log_pruned = job.logPruned ?? false;
  d.release_id = job.releaseId ?? null;
  d.parent_job_id = job.parentJobId ?? null;
  d.release_deadline_at = job.releaseDeadlineAt ?? null;
  d.prompt_bytes = job.promptBytes ?? null;
  d.work_summary = job.workSummary ?? null;
  d.modified_files = job.modifiedFiles ?? null;
  d.lines_added = job.linesAdded ?? null;
  d.lines_removed = job.linesRemoved ?? null;
  d.provider = job.provider ?? null;
  d.run_score = job.runScore ?? null;
  d.skill_ids = job.skillIds ?? '[]';
  const verdict = getVerdict(job);
  if (verdict !== null) d.verdict = verdict;
  return d;
}
