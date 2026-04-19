import { eq } from 'drizzle-orm';
import { existsSync, readFileSync, appendFileSync } from 'fs';
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
  parentJobId?: string | null;
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
        parentJobId: row.parentJobId ?? null,
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
// fix-ci retries — live-read from settings so the user can tune this in the UI
// without restarting the server. Only crash-fast failures are retried so real
// errors still surface.
async function getFixCiRetryConfig(): Promise<{ maxRetries: number; windowSeconds: number; fastCrashMs: number }> {
  try {
    const { getSettings } = await import('./config');
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

function recentFixCount(projectName: string): number {
  const cutoff = Date.now() / 1000 - FIX_WINDOW_SECONDS;
  return listJobs().filter(
    (j) => j.project === projectName && j.kind === 'fix' && j.startedAt >= cutoff
  ).length;
}

// Find the most recent in-flight release job for this project — the single
// terminal the user watches during a release. Each pipeline step appends
// its section to this job's log.
function findActiveReleaseJob(projectName: string): JobData | null {
  const candidates = listJobs()
    .filter(j => j.project === projectName && j.kind === 'release' && j.finishedAt === null)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return candidates[0] ?? null;
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

async function finalizeReleaseJob(release: JobData, exitCode: number): Promise<void> {
  if (release.finishedAt !== null) return;
  try {
    if (release.logPath) {
      appendFileSync(release.logPath, `\n# release finished — exit ${exitCode} — ${new Date().toISOString()}\n`);
    }
  } catch {}
  await markDone(release, exitCode);
}

async function runCompletionHooks(job: JobData): Promise<void> {
  // Stream per-step output into the active release meta-log so the user can
  // watch the whole pipeline in one terminal.
  if (['test', 'review', 'fix', 'push'].includes(job.kind)) {
    const release = findActiveReleaseJob(job.project);
    if (release) appendToReleaseLog(release, job.kind, job);
  }

  // Tracks whether this hook kicked off a downstream step. If not, the
  // release meta-job is at a natural endpoint and should be finalized so the
  // UI doesn't render it as "live" forever.
  let chainedNext = false;

  if (job.kind === 'review') {
    if (job.exitCode === 0) {
      try {
        const { resolveProjectPath } = await import('./project-data');
        const projPath = resolveProjectPath(job.project);
        if (projPath) await markReviewed(job.project, projPath);
      } catch {}
    }
    // Release pipeline: review LGTM → push; NEEDS ATTENTION/DO NOT SHIP → fix
    try {
      if (job.exitCode === 0 && (await isAutoPushEnabled(job.project))) {
        const verdict = getVerdict(job);
        if (verdict === 'LGTM') {
          const { startProjectPush } = await import('./start-push');
          const r = await startProjectPush(job.project);
          if (!r.ok) {
            console.log(`[release] push failed for ${job.project}: ${r.detail}`);
          } else {
            console.log(`[release] review LGTM → pushed ${job.project} (${r.commitSha || 'no-op'})`);
          }
          // startProjectPush creates a 'push' job that will itself finalize
          // the release via its own completion hook.
          chainedNext = true;
        } else if (verdict === 'NEEDS ATTENTION' || verdict === 'DO NOT SHIP') {
          const count = recentFixCount(job.project);
          if (count < MAX_FIX_ITERATIONS) {
            const { startFixFromJob } = await import('./start-fix');
            const r = await startFixFromJob(job.id);
            if (r.ok) {
              console.log(`[release] review ${verdict} → started fix ${r.jobId} (iter ${count + 1})`);
              chainedNext = true;
            } else {
              console.log(`[release] skipped fix for ${job.project}: ${r.detail}`);
            }
          } else {
            console.log(`[release] fix cap reached for ${job.project} (${count}/${MAX_FIX_ITERATIONS}) — stopping`);
          }
        }
        // else: unknown / no verdict — fall through, release will finalize below
      }
    } catch (e) {
      console.log(`[release] review hook error for ${job.project}:`, e);
    }
  }

  if (job.kind === 'fix' && job.exitCode === 0) {
    try {
      if (await isAutoPushEnabled(job.project)) {
        const { startProjectReview } = await import('./start-review');
        const r = await startProjectReview(job.project);
        if (r.ok) {
          console.log(`[fix→review] auto-started review ${r.jobId} for ${job.project}`);
          chainedNext = true;
        } else {
          console.log(`[fix→review] skipped auto-review for ${job.project}: ${r.detail}`);
        }
      }
    } catch (e) {
      console.log(`[fix→review] error starting auto-review for ${job.project}:`, e);
    }
  }

  if (job.kind === 'test' && job.exitCode === 0) {
    try {
      if (await isAutoPushEnabled(job.project)) {
        const { startProjectReview } = await import('./start-review');
        const r = await startProjectReview(job.project);
        if (r.ok) {
          console.log(`[release] tests passed → started review ${r.jobId} for ${job.project}`);
          chainedNext = true;
        } else {
          console.log(`[release] test→review skipped for ${job.project}: ${r.detail}`);
        }
      }
    } catch (e) {
      console.log(`[release] test hook error for ${job.project}:`, e);
    }
  }

  // If this is a pipeline step and we didn't chain to another step, the
  // release job reached a natural endpoint — finalize it. Exit code mirrors
  // this step's outcome.
  if (['test', 'review', 'fix', 'push'].includes(job.kind) && !chainedNext) {
    const release = findActiveReleaseJob(job.project);
    if (release) {
      const exitCode = (job.exitCode === 0) ? 0 : 1;
      await finalizeReleaseJob(release, exitCode);
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
  // The real verdict is always near the end of the output. Search only the
  // tail to avoid matching code snippets like `verdict === 'LGTM'` or the
  // review prompt's own "Verdict: LGTM / NEEDS ATTENTION / DO NOT SHIP"
  // instructions further up in the log.
  const tail = log.slice(-2000);
  // Multi-line "Verdict\n**X**" form: "Verdict" header followed by a token
  // within a short window of non-alpha characters (whitespace, punctuation,
  // markdown bold, list markers).
  // Reject matches where the verdict is immediately followed by "/" — that's
  // the prompt's own "LGTM / NEEDS ATTENTION / DO NOT SHIP" listing, not a
  // decision.
  const multiline = [...tail.matchAll(/[Vv]erdict[^A-Za-z]{1,80}?(LGTM|NEEDS ATTENTION|DO NOT SHIP)(?![*_` ]*\s*\/)/g)];
  if (multiline.length > 0) return multiline[multiline.length - 1][1];
  // Fallback: scan the final non-empty lines for a verdict token at the
  // start (with optional markdown decoration) followed by either end-of-line
  // or a separator like " — ", ":", " -" introducing a one-line rationale.
  // Accepts bare `LGTM`, `**LGTM**`, `LGTM — summary`, `LGTM: summary`, etc.
  // Rejects `LGTM / NEEDS ATTENTION / DO NOT SHIP` (the prompt's own enum)
  // because that line has a "/" right after the token.
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
  const lineTokenRe = /^[*_` ]*(LGTM|NEEDS ATTENTION|DO NOT SHIP)[*_` ]*(?:\s*[-–—:]|\s*$)(?![*_` ]*\s*\/)/;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const m = lineTokenRe.exec(lines[i]);
    if (m) return m[1];
  }
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
