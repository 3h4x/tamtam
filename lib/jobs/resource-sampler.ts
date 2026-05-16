// Per-job resource sampler. Called from the probe sweep — for each running
// job that has a usable pid, run `ps -o %cpu=,rss= -p <pid>` and write a
// row to job_resource_samples. Best-effort: dead pids, exotic OSes, or
// transient ps failures are silently skipped.
//
// Skips:
//   - pid == 0 (in-process inline kinds like mark-dod / pr-wait — they
//     contribute to the server process, not a separable subprocess)
//   - pid == process.pid or server-owned coordinator/inline kinds whose
//     persisted pid is a liveness marker rather than a child process
//   - pid < 100 (system PIDs; defensive guard against corrupt rows)
//   - jobs without a pid

import { db, schema } from '@/lib/db';
import { exec } from '@/lib/shared/shell';
import type { JobData } from '@/lib/jobs/types';

interface SampleRow {
  jobId: string;
  cpuPct: number | null;
  rssKb: number | null;
}

/** Parse `%cpu rss` from `ps -o %cpu=,rss= -p <pid>` output. Returns nulls
 *  if the format is unrecognized (e.g. ps printed an error to stderr but
 *  exit 0 on a strange platform). */
function parsePsOutput(stdout: string): { cpuPct: number | null; rssKb: number | null } {
  const line = stdout.trim().split('\n')[0]?.trim() ?? '';
  if (!line) return { cpuPct: null, rssKb: null };
  const parts = line.split(/\s+/);
  if (parts.length < 2) return { cpuPct: null, rssKb: null };
  const cpu = Number(parts[0]);
  const rss = Number(parts[1]);
  return {
    cpuPct: Number.isFinite(cpu) ? cpu : null,
    rssKb: Number.isFinite(rss) ? Math.round(rss) : null,
  };
}

async function sampleOne(jobId: string, pid: number): Promise<SampleRow | null> {
  try {
    const r = await exec('ps', ['-o', '%cpu=,rss=', '-p', String(pid)], { timeout: 2000 });
    if (r.exitCode !== 0) return null;
    const { cpuPct, rssKb } = parsePsOutput(r.stdout || '');
    return { jobId, cpuPct, rssKb };
  } catch {
    return null;
  }
}

function isServerOwnedMarkerKind(kind: string): boolean {
  return kind === 'release' || kind === 'push' || kind === 'commit';
}

function hasSampleablePid(job: JobData): boolean {
  return job.finishedAt === null &&
    typeof job.pid === 'number' &&
    job.pid > 100 &&
    job.pid !== process.pid &&
    !isServerOwnedMarkerKind(job.kind);
}

/** One sweep tick — sample every eligible running job and append rows. */
export async function sampleRunningJobResources(): Promise<{ sampled: number; skipped: number }> {
  const { listJobs } = await import('@/lib/jobs/job-storage');
  const running = listJobs().filter(hasSampleablePid);

  let sampled = 0;
  let skipped = 0;
  const now = Date.now() / 1000;
  const rows: { jobId: string; sampledAt: number; cpuPct: number | null; rssKb: number | null }[] = [];

  for (const job of running) {
    const sample = await sampleOne(job.id, job.pid as number);
    if (!sample) { skipped += 1; continue; }
    rows.push({ jobId: sample.jobId, sampledAt: now, cpuPct: sample.cpuPct, rssKb: sample.rssKb });
    sampled += 1;
  }

  if (rows.length > 0) {
    try {
      await db.insert(schema.jobResourceSamples).values(rows).execute();
    } catch (err) {
      console.error('[resource-sampler] insert failed:', err);
    }
  }

  return { sampled, skipped };
}
