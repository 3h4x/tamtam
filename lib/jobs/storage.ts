import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getVerdict } from './verdict';
import { currentParent } from './parent-context';
import type { JobData } from './types';

export { runWithParent } from './parent-context';

export const jobsCache = new Map<string, JobData>();
let loaded = false;

export function loadFromDb(): void {
  if (loaded) return;
  try {
    const rows = db.select().from(schema.jobs).all();
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
        promptBytes: row.promptBytes ?? null,
        workSummary: row.workSummary ?? null,
        modifiedFiles: row.modifiedFiles ?? null,
      });
    }
    loaded = true;
  } catch (e) {
    console.error('Failed to load jobs from DB:', e);
  }
}

export function saveToDb(job: JobData): void {
  try {
    db.insert(schema.jobs)
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
        promptBytes: job.promptBytes ?? null,
        workSummary: job.workSummary ?? null,
        modifiedFiles: job.modifiedFiles ?? null,
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
          logPruned: job.logPruned ?? false,
          verdict: job.verdict ?? null,
          costUsd: job.costUsd ?? null,
          model: job.model ?? null,
          releaseId: job.releaseId ?? null,
          abortedAt: job.abortedAt ?? null,
          promptBytes: job.promptBytes ?? null,
          workSummary: job.workSummary ?? null,
          modifiedFiles: job.modifiedFiles ?? null,
        },
      })
      .run();
  } catch (e) {
    console.error(`Failed to save job ${job.id}:`, e);
  }
}

// Find the most recent in-flight release job for this project — the single
// terminal the user watches during a release. Each pipeline step appends
// its section to this job's log.
export function findActiveReleaseJob(projectName: string): JobData | null {
  const candidates = listJobs()
    .filter(j => j.project === projectName && j.kind === 'release' && j.finishedAt === null)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return candidates[0] ?? null;
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
): JobData {
  loadFromDb();
  let timestamp = Math.floor(Date.now() * 1000);
  let jobId = `${project}-${kind}-${timestamp}`;
  while (jobsCache.has(jobId)) {
    timestamp += 1;
    jobId = `${project}-${kind}-${timestamp}`;
  }
  // Auto-link to the active release so every pipeline step carries releaseId.
  // Release jobs themselves get releaseId = their own id, set explicitly by
  // start-release.ts after creation (kind check here avoids circular reference).
  const autoReleaseId = kind !== 'release' ? (findActiveReleaseJob(project)?.id ?? null) : null;
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
    parentJobId: parentJobId ?? currentParent(),
    ghIssueNumber: ghIssueNumber ?? null,
    ghIssueRepo: ghIssueRepo ?? null,
    ghIssueTitle: ghIssueTitle ?? null,
    releaseId: autoReleaseId,
    workSummary: null,
    modifiedFiles: null,
  };
  jobsCache.set(jobId, job);
  saveToDb(job);
  return job;
}

export function getJob(jobId: string): JobData | null {
  loadFromDb();
  const cached = jobsCache.get(jobId);
  if (cached) return cached;
  const row = db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .get();
  if (!row) return null;
  const job: JobData = {
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
    ghIssueNumber: row.ghIssueNumber ?? null,
    ghIssueRepo: row.ghIssueRepo ?? null,
    ghIssueTitle: row.ghIssueTitle ?? null,
    logPruned: row.logPruned ?? false,
    verdict: row.verdict ?? null,
    costUsd: row.costUsd ?? null,
    model: row.model ?? null,
    releaseId: row.releaseId ?? null,
    abortedAt: row.abortedAt ?? null,
    promptBytes: row.promptBytes ?? null,
    workSummary: row.workSummary ?? null,
    modifiedFiles: row.modifiedFiles ?? null,
  };
  jobsCache.set(jobId, job);
  return job;
}

// Persist verdict without a full job round-trip. Called right after a review
// finishes so the verdict survives log pruning.
export function persistVerdict(jobId: string, verdict: string): void {
  const job = jobsCache.get(jobId);
  if (job) job.verdict = verdict;
  try {
    db.update(schema.jobs)
      .set({ verdict })
      .where(eq(schema.jobs.id, jobId))
      .run();
  } catch (e) {
    console.error(`Failed to persist verdict for ${jobId}:`, e);
  }
}

export function listJobs(): JobData[] {
  loadFromDb();
  return Array.from(jobsCache.values());
}

export function unseenFinished(): JobData[] {
  loadFromDb();
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

export function updateJob(job: JobData): void {
  saveToDb(job);
}

export function jobToDict(job: JobData): Record<string, unknown> {
  const d: Record<string, unknown> = {
    id: job.id,
    project: job.project,
    kind: job.kind,
    prompt: job.prompt,
    pid: job.pid,
    log_path: job.logPath,
    status: job.abortedAt !== null && job.abortedAt !== undefined ? 'aborted' : job.finishedAt !== null ? 'done' : 'running',
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
  d.prompt_bytes = job.promptBytes ?? null;
  d.work_summary = job.workSummary ?? null;
  d.modified_files = job.modifiedFiles ?? null;
  const verdict = getVerdict(job);
  if (verdict !== null) d.verdict = verdict;
  return d;
}
