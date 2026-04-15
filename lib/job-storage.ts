import { eq } from 'drizzle-orm';
import { existsSync, readFileSync } from 'fs';
import { db, schema } from './db';
import { getJobStatus } from './pm2-jobs';
import { markReviewed } from './git-utils';

export interface JobData {
  id: string;
  project: string;
  kind: string;
  pid: number;
  logPath: string | null;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  seen: boolean;
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
        pid: row.pid,
        logPath: row.logPath,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt ?? null,
        exitCode: row.exitCode ?? null,
        seen: row.seen ?? false,
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
        pid: job.pid,
        logPath: job.logPath,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        exitCode: job.exitCode,
        seen: job.seen,
      })
      .onConflictDoUpdate({
        target: schema.jobs.id,
        set: {
          pid: job.pid,
          logPath: job.logPath,
          finishedAt: job.finishedAt,
          exitCode: job.exitCode,
          seen: job.seen,
        },
      })
      .run();
  } catch (e) {
    console.error(`Failed to save job ${job.id}:`, e);
  }
}

async function markDone(job: JobData, exitCode: number): Promise<void> {
  job.finishedAt = Date.now() / 1000;
  job.exitCode = exitCode;
  saveToDb(job);
  await runCompletionHooks(job);
}

async function runCompletionHooks(job: JobData): Promise<void> {
  if (job.kind === 'review' && job.exitCode === 0) {
    try {
      const { resolveProjectPath } = await import('./project-data');
      const projPath = resolveProjectPath(job.project);
      if (projPath) await markReviewed(job.project, projPath);
    } catch {}
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

export function updateJob(job: JobData): void {
  saveToDb(job);
}

export function getVerdict(job: JobData): string | null {
  if (job.kind !== 'review' || job.finishedAt === null) return null;
  const log = readLog(job, 2000);
  if (!log) return null;
  const match = log.match(/[Vv]erdict.*?(LGTM|NEEDS ATTENTION|DO NOT SHIP)/);
  return match ? match[1] : null;
}

export function jobToDict(job: JobData): Record<string, any> {
  const d: Record<string, any> = {
    id: job.id,
    project: job.project,
    kind: job.kind,
    pid: job.pid,
    log_path: job.logPath,
    status: job.finishedAt !== null ? 'done' : 'running',
    exit_code: job.exitCode,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    seen: job.seen,
  };
  const verdict = getVerdict(job);
  if (verdict !== null) d.verdict = verdict;
  return d;
}

export async function probeJobStatus(job: JobData): Promise<'running' | 'done'> {
  if (job.finishedAt !== null) return 'done';
  if (job.pid <= 0) {
    await markDone(job, -1);
    return 'done';
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
  } catch (e: any) {
    if (e.code === 'EPERM') return 'running';
    await markDone(job, -1);
    return 'done';
  }
}

export function createJob(
  project: string,
  kind: string,
  pid: number,
  logPath: string
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
    pid,
    logPath,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
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
    pid: row.pid,
    logPath: row.logPath,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? null,
    exitCode: row.exitCode ?? null,
    seen: row.seen ?? false,
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
