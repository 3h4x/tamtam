import { eq } from 'drizzle-orm';
import { existsSync, readFileSync } from 'fs';
import { db, schema } from './db';
import { getJobStatus } from './pm2-jobs';
import { markReviewed } from './git-utils';
import { parseStreamLines } from './claude-stream-parser';

export interface JobData {
  id: string;
  project: string;
  kind: string;
  prompt: string | null;
  pid: number;
  logPath: string | null;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  seen: boolean;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreateTokens?: number | null;
  sessionId?: string | null;
  contextMeta?: string | null;
  userPrompt?: string | null;
}

const jobsCache = new Map<string, JobData>();
let loaded = false;

function loadFromDb(): void {
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
      });
    }
    loaded = true;
  } catch (e) {
    console.error('Failed to load jobs from DB:', e);
  }
}

function saveToDb(job: JobData): void {
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
        },
      })
      .run();
  } catch (e) {
    console.error(`Failed to save job ${job.id}:`, e);
  }
}

export async function markDone(job: JobData, exitCode: number): Promise<void> {
  // Idempotent: if already finalized, don't double-fire hooks or rewrite DB.
  if (job.finishedAt !== null) return;
  job.finishedAt = Date.now() / 1000;
  job.exitCode = exitCode;
  // Extract result metadata (tokens, duration, session) from log
  const rawLog = readLog(job, 50_000);
  const events = parseStreamLines(rawLog);
  const doneEvent = events.find(e => e.type === 'done');
  if (doneEvent && doneEvent.type === 'done') {
    job.durationMs = doneEvent.result.duration;
    job.inputTokens = doneEvent.result.inputTokens;
    job.outputTokens = doneEvent.result.outputTokens;
    job.cacheReadTokens = doneEvent.result.cacheReadTokens;
    job.cacheCreateTokens = doneEvent.result.cacheCreateTokens;
    job.sessionId = doneEvent.result.sessionId;
    // Claude completed successfully — override pm2's exit code. Claude CLI
    // sometimes hangs after flushing its final result and gets killed, which
    // makes pm2 report -1, but the logical outcome was a clean finish.
    if ((job.kind === 'run' || job.kind === 'review') && !doneEvent.result.error && exitCode !== 0) {
      console.log(`[job ${job.id}] claude result present (is_error=false) but pm2 reported exit ${exitCode}; overriding to 0`);
      job.exitCode = 0;
    }
  }
  saveToDb(job);
  await runCompletionHooks(job);
  // Clean up PM2 process now that it's saved to DB
  try {
    const { deleteJob } = await import('./pm2-jobs');
    await deleteJob(job.id);
  } catch {}
  // Fallback: explicitly SIGKILL the bash wrapper and any children in case
  // Claude CLI hung and escaped pm2's tree-kill.
  if (job.pid > 0) {
    try {
      const { exec } = await import('./shell');
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

async function isAutoPushEnabled(projectName: string): Promise<boolean> {
  try {
    const { getProjectTestConfig } = await import('./scheduling');
    return !!getProjectTestConfig(projectName)?.autoPushEnabled;
  } catch {
    return false;
  }
}

// Cap runaway review→fix→review loops when auto-push is on. Override via
// TAMTAM_MAX_FIX_ITERATIONS / TAMTAM_FIX_WINDOW_SECONDS for debugging or tuning
// per-environment without a code change.
const MAX_FIX_ITERATIONS = parseInt(process.env.TAMTAM_MAX_FIX_ITERATIONS ?? '', 10) || 3;
const FIX_WINDOW_SECONDS = parseInt(process.env.TAMTAM_FIX_WINDOW_SECONDS ?? '', 10) || 30 * 60;

function recentFixCount(projectName: string): number {
  const cutoff = Date.now() / 1000 - FIX_WINDOW_SECONDS;
  return listJobs().filter(
    (j) => j.project === projectName && j.kind === 'fix' && j.startedAt >= cutoff
  ).length;
}

async function runCompletionHooks(job: JobData): Promise<void> {
  if (job.kind === 'review' && job.exitCode === 0) {
    try {
      const { resolveProjectPath } = await import('./project-data');
      const projPath = resolveProjectPath(job.project);
      if (projPath) await markReviewed(job.project, projPath);
    } catch {}
    // Release pipeline: review LGTM → push; NEEDS ATTENTION/DO NOT SHIP → fix
    try {
      if (!(await isAutoPushEnabled(job.project))) return;
      const verdict = getVerdict(job);
      if (verdict === 'LGTM') {
        const { startProjectPush } = await import('./start-push');
        const r = await startProjectPush(job.project);
        if (!r.ok) {
          console.log(`[release] push failed for ${job.project}: ${r.detail}`);
        } else {
          console.log(`[release] review LGTM → pushed ${job.project} (${r.commitSha || 'no-op'})`);
        }
      } else if (verdict === 'NEEDS ATTENTION' || verdict === 'DO NOT SHIP') {
        const count = recentFixCount(job.project);
        if (count >= MAX_FIX_ITERATIONS) {
          console.log(`[release] fix cap reached for ${job.project} (${count}/${MAX_FIX_ITERATIONS}) — stopping`);
          return;
        }
        const { startFixFromJob } = await import('./start-fix');
        const r = await startFixFromJob(job.id);
        if (!r.ok) {
          console.log(`[release] skipped fix for ${job.project}: ${r.detail}`);
        } else {
          console.log(`[release] review ${verdict} → started fix ${r.jobId} (iter ${count + 1})`);
        }
      }
    } catch (e) {
      console.log(`[release] review hook error for ${job.project}:`, e);
    }
  }
  if (job.kind === 'fix' && job.exitCode === 0) {
    try {
      if (!(await isAutoPushEnabled(job.project))) return;
      const { startProjectReview } = await import('./start-review');
      const r = await startProjectReview(job.project);
      if (!r.ok) {
        console.log(`[fix→review] skipped auto-review for ${job.project}: ${r.detail}`);
      } else {
        console.log(`[fix→review] auto-started review ${r.jobId} for ${job.project}`);
      }
    } catch (e) {
      console.log(`[fix→review] error starting auto-review for ${job.project}:`, e);
    }
  }
  if (job.kind === 'test' && job.exitCode === 0) {
    // Release pipeline: test passes → review
    try {
      if (!(await isAutoPushEnabled(job.project))) return;
      const { startProjectReview } = await import('./start-review');
      const r = await startProjectReview(job.project);
      if (!r.ok) {
        console.log(`[release] test→review skipped for ${job.project}: ${r.detail}`);
      } else {
        console.log(`[release] tests passed → started review ${r.jobId} for ${job.project}`);
      }
    } catch (e) {
      console.log(`[release] test hook error for ${job.project}:`, e);
    }
  }
}

export function readLog(job: JobData, tailBytes = 100_000): string {
  if (!job.logPath || !existsSync(job.logPath)) return '';
  try {
    const content = readFileSync(job.logPath, 'utf-8');
    if (content.length > tailBytes) {
      const tail = content.slice(-tailBytes);
      const newlineIdx = tail.indexOf('\n');
      return newlineIdx >= 0 ? tail.slice(newlineIdx + 1) : tail;
    }
    return content;
  } catch {
    return '';
  }
}

export function readParsedLog(job: JobData, tailBytes = 100_000): string {
  const rawLog = readLog(job, tailBytes);
  if (!rawLog) return '';

  // Try to parse as stream events and extract text
  const events = parseStreamLines(rawLog);
  const textParts: string[] = [];

  for (const event of events) {
    if (event.type === 'text') {
      textParts.push(event.text);
    } else if (event.type === 'tool_use') {
      textParts.push(`\n\n> Tool: ${event.name}\n`);
    } else if (event.type === 'tool_result') {
      const truncated = event.content.length > 500
        ? event.content.slice(0, 500) + '...'
        : event.content;
      textParts.push(`${truncated}\n`);
    } else if (event.type === 'done') {
      // Cost/duration stored in DB, not shown inline
    }
  }

  // If we extracted text, return it; otherwise return raw log
  if (textParts.length > 0) {
    return textParts.join('');
  }

  return rawLog;
}

export function updateJob(job: JobData): void {
  saveToDb(job);
}

export function getVerdict(job: JobData): string | null {
  if (job.kind !== 'review' || job.finishedAt === null) return null;
  // Use parsed log — raw stream-json encodes newlines as literal "\n",
  // which breaks word boundaries and masks a trailing verdict token.
  const log = readParsedLog(job, 100_000);
  if (!log) return null;
  const explicit = log.match(/[Vv]erdict[^\n]*?(LGTM|NEEDS ATTENTION|DO NOT SHIP)/);
  if (explicit) return explicit[1];
  // Fallback: only accept a token when it stands alone on the final non-empty
  // line. Bare tokens anywhere in prose are too easy to mis-classify
  // (e.g. "not LGTM" → LGTM), and auto-push acts on this.
  const lines = log.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (last && /^(LGTM|NEEDS ATTENTION|DO NOT SHIP)$/.test(last)) return last;
  return null;
}

export function jobToDict(job: JobData): Record<string, unknown> {
  const d: Record<string, unknown> = {
    id: job.id,
    project: job.project,
    kind: job.kind,
    prompt: job.prompt,
    pid: job.pid,
    log_path: job.logPath,
    status: job.finishedAt !== null ? 'done' : 'running',
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
  };
  const verdict = getVerdict(job);
  if (verdict !== null) d.verdict = verdict;
  return d;
}

function logHasClaudeResult(job: JobData): boolean {
  if (!job.logPath || !existsSync(job.logPath)) return false;
  try {
    const content = readFileSync(job.logPath, 'utf-8');
    return content.includes('"type":"result"');
  } catch {
    return false;
  }
}

export async function probeJobStatus(job: JobData): Promise<'running' | 'done'> {
  if (job.finishedAt !== null) return 'done';
  if (job.pid <= 0) {
    await markDone(job, -1);
    return 'done';
  }
  // Claude CLI sometimes hangs after emitting its final result event. If the log
  // already contains a result line, treat the job as done regardless of PM2 status.
  if ((job.kind === 'run' || job.kind === 'review') && logHasClaudeResult(job)) {
    await markDone(job, 0);
    return 'done';
  }
  // Test/action jobs spawn directly (no PM2) — check liveness via pid only.
  if (job.kind === 'test' || job.kind === 'action') {
    try {
      process.kill(job.pid, 0);
      return 'running';
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return 'running';
      await markDone(job, -1);
      return 'done';
    }
  }
  const { status, exitCode } = await getJobStatus(job.id);
  if (status === 'running') return 'running';
  if (status === 'done') {
    await markDone(job, exitCode ?? -1);
    return 'done';
  }
  try {
    process.kill(job.pid, 0);
    return 'running';
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return 'running';
    await markDone(job, -1);
    return 'done';
  }
}

export function createJob(
  project: string,
  kind: string,
  pid: number,
  logPath: string,
  prompt?: string,
  contextMeta?: string,
  userPrompt?: string
): JobData {
  loadFromDb();
  let timestamp = Math.floor(Date.now() * 1000);
  let jobId = `${project}-${kind}-${timestamp}`;
  while (jobsCache.has(jobId)) {
    timestamp += 1;
    jobId = `${project}-${kind}-${timestamp}`;
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
  };
  jobsCache.set(jobId, job);
  return job;
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
