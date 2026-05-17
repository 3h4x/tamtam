import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

let sharedHandle: TestDbHandle;

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS job_resource_samples (
      id serial PRIMARY KEY,
      job_id text NOT NULL,
      sampled_at double precision NOT NULL,
      cpu_pct double precision,
      rss_kb integer
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS job_resource_samples_job_sampled
      ON job_resource_samples (job_id, sampled_at)
  `));
}

function withStubs(opts: { jobs: Array<Record<string, unknown>>; psResults?: Record<number, { exitCode: number; stdout: string }> }) {
  const exec = vi.fn(async (_cmd: string, args: string[]) => {
    const pidArg = args[args.indexOf('-p') + 1];
    const pid = Number(pidArg);
    const res = opts.psResults?.[pid];
    if (res) return res;
    return { exitCode: 1, stdout: '', stderr: 'no such process' };
  });

  vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
  vi.doMock('@/lib/jobs/job-storage', () => ({ listJobs: () => opts.jobs }));
  vi.doMock('@/lib/shared/shell', () => ({ exec }));

  return { exec };
}

describe('sampleRunningJobResources', () => {
  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await sharedHandle[Symbol.asyncDispose]();
  });

  beforeEach(() => vi.resetModules());
  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE job_resource_samples RESTART IDENTITY'));
  });
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('writes a row per eligible running job parsing %cpu and rss', async () => {
    withStubs({
      jobs: [
        { id: 'job-a', pid: 1234, finishedAt: null },
        { id: 'job-b', pid: 5678, finishedAt: null },
      ],
      psResults: {
        1234: { exitCode: 0, stdout: ' 12.5 65432\n' },
        5678: { exitCode: 0, stdout: '  0.1   2048' },
      },
    });

    const { sampleRunningJobResources } = await import('@/lib/jobs/resource-sampler');
    const result = await sampleRunningJobResources();

    expect(result.sampled).toBe(2);
    expect(result.skipped).toBe(0);

    const rows = await sharedHandle.db.select().from(schema.jobResourceSamples).orderBy(schema.jobResourceSamples.jobId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.jobId === 'job-a')).toMatchObject({ cpuPct: 12.5, rssKb: 65432 });
    expect(rows.find((r) => r.jobId === 'job-b')).toMatchObject({ cpuPct: 0.1, rssKb: 2048 });
  });

  it('skips finished jobs and PIDs <= 100', async () => {
    const { exec } = withStubs({
      jobs: [
        { id: 'finished', pid: 1234, finishedAt: 1.0 },
        { id: 'system-pid', pid: 1, finishedAt: null },
        { id: 'inline', pid: 0, finishedAt: null },
      ],
      psResults: { 1234: { exitCode: 0, stdout: '50 1000\n' } },
    });

    const { sampleRunningJobResources } = await import('@/lib/jobs/resource-sampler');
    const result = await sampleRunningJobResources();

    expect(result.sampled).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    const rows = await sharedHandle.db.select().from(schema.jobResourceSamples);
    expect(rows).toHaveLength(0);
  });

  it('skips server-owned marker PIDs instead of sampling the TamTam process', async () => {
    const { exec } = withStubs({
      jobs: [
        { id: 'current-server', kind: 'agent:reviewer', pid: process.pid, finishedAt: null },
        { id: 'release-marker', kind: 'release', pid: 4321, finishedAt: null },
        { id: 'push-marker', kind: 'push', pid: 5432, finishedAt: null },
        { id: 'commit-marker', kind: 'commit', pid: 6543, finishedAt: null },
      ],
      psResults: {
        [process.pid]: { exitCode: 0, stdout: '99 999999\n' },
        4321: { exitCode: 0, stdout: '10 1000\n' },
        5432: { exitCode: 0, stdout: '20 2000\n' },
        6543: { exitCode: 0, stdout: '30 3000\n' },
      },
    });

    const { sampleRunningJobResources } = await import('@/lib/jobs/resource-sampler');
    const result = await sampleRunningJobResources();

    expect(result.sampled).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    const rows = await sharedHandle.db.select().from(schema.jobResourceSamples);
    expect(rows).toHaveLength(0);
  });

  it('skips dead PIDs cleanly (ps exit 1) without throwing', async () => {
    withStubs({
      jobs: [{ id: 'dead', pid: 9999, finishedAt: null }],
      psResults: {},
    });

    const { sampleRunningJobResources } = await import('@/lib/jobs/resource-sampler');
    const result = await sampleRunningJobResources();
    expect(result.sampled).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
