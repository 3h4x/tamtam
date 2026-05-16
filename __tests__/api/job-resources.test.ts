import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

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

describe('GET /api/jobs/[jobId]/resources', () => {
  let GET: typeof import('@/app/api/jobs/[jobId]/resources/route').GET;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await sharedHandle[Symbol.asyncDispose]();
  });

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE job_resource_samples RESTART IDENTITY'));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    GET = (await import('@/app/api/jobs/[jobId]/resources/route')).GET;
  });

  it('returns ordered samples for the requested job with the default limit', async () => {
    await sharedHandle.db.insert(schema.jobResourceSamples).values([
      { jobId: 'job-1', sampledAt: 30, cpuPct: 3.5, rssKb: 300 },
      { jobId: 'job-2', sampledAt: 20, cpuPct: 9.5, rssKb: 900 },
      { jobId: 'job-1', sampledAt: 10, cpuPct: 1.5, rssKb: 100 },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/jobs/job-1/resources'), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      jobId: 'job-1',
      samples: [
        { t: 10, cpu: 1.5, rss: 100 },
        { t: 30, cpu: 3.5, rss: 300 },
      ],
    });
  });

  it('filters samples by since', async () => {
    await sharedHandle.db.insert(schema.jobResourceSamples).values([
      { jobId: 'job-1', sampledAt: 10, cpuPct: 1, rssKb: 100 },
      { jobId: 'job-1', sampledAt: 20, cpuPct: 2, rssKb: 200 },
      { jobId: 'job-1', sampledAt: 30, cpuPct: 3, rssKb: 300 },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/jobs/job-1/resources?since=20'), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.samples).toEqual([
      { t: 20, cpu: 2, rss: 200 },
      { t: 30, cpu: 3, rss: 300 },
    ]);
  });

  it('caps explicit limits at 5000', async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({
      jobId: 'job-1',
      sampledAt: i + 1,
      cpuPct: i % 100,
      rssKb: 1000 + i,
    }));
    await sharedHandle.db.insert(schema.jobResourceSamples).values(rows);

    const res = await GET(new NextRequest('http://localhost/api/jobs/job-1/resources?limit=9999'), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.samples).toHaveLength(5000);
    expect(data.samples[0]).toEqual({ t: 1, cpu: 0, rss: 1000 });
    expect(data.samples[4999]).toEqual({ t: 5000, cpu: 99, rss: 5999 });
  });

  it('returns an empty series when no samples exist', async () => {
    const res = await GET(new NextRequest('http://localhost/api/jobs/job-1/resources'), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ jobId: 'job-1', samples: [] });
  });

  it.each(['-1', '0', '1.5', 'abc'])('rejects invalid limit %s', async (limit) => {
    const res = await GET(new NextRequest(`http://localhost/api/jobs/job-1/resources?limit=${limit}`), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ detail: 'limit must be a positive integer' });
  });

  it('rejects invalid since values', async () => {
    const res = await GET(new NextRequest('http://localhost/api/jobs/job-1/resources?since=-1'), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      detail: 'since must be a non-negative Unix timestamp in seconds',
    });
  });

  it('returns 500 when the resource query fails', async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({
      schema,
      db: {
        select: () => {
          throw new Error('db offline');
        },
      },
    }));
    const failingGET = (await import('@/app/api/jobs/[jobId]/resources/route')).GET;

    const res = await failingGET(new NextRequest('http://localhost/api/jobs/job-1/resources'), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ detail: 'resource query failed: db offline' });
  });
});
