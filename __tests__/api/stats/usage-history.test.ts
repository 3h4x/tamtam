import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { schema } from '@/lib/db';
import { createTestPgDb, type TestDbHandle } from '@/__tests__/helpers/test-db';
import type { UsageHistoryBucket } from '@/app/api/stats/usage-history/route';

let sharedHandle: TestDbHandle;

describe('GET /api/stats/usage-history', () => {
  let GET: typeof import('@/app/api/stats/usage-history/route').GET;

  beforeAll(async () => {
    sharedHandle = await createTestPgDb();
  });

  afterAll(async () => {
    await sharedHandle[Symbol.asyncDispose]();
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T12:00:00Z'));
    await sharedHandle.db.execute('TRUNCATE usage_hourly_snapshot');
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/app/api/stats/usage-history/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('returns empty series when no data exists', async () => {
    const req = new Request('http://localhost:3000/api/stats/usage-history?hours=48');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json).toHaveProperty('generatedAt');
    expect(json).toHaveProperty('hours', 48);
    expect(json).toHaveProperty('series');
    expect(Array.isArray(json.series)).toBe(true);
    expect(json.series).toHaveLength(0);
  });

  it('respects the hours query parameter', async () => {
    const req = new Request('http://localhost:3000/api/stats/usage-history?hours=24');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.hours).toBe(24);
  });

  it('clamps hours to max (336)', async () => {
    const req = new Request('http://localhost:3000/api/stats/usage-history?hours=9999');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.hours).toBe(336);
  });

  it('defaults to 48 hours when no parameter provided', async () => {
    const req = new Request('http://localhost:3000/api/stats/usage-history');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.hours).toBe(48);
  });

  it('returns series with correct shape when data exists', async () => {
    const now = Date.now();
    const bucketTs = now - 2 * 60 * 60 * 1000;

    await sharedHandle.db.insert(schema.usageHourlySnapshot).values({
      bucketTs,
      provider: 'claude',
      windowKey: '7d',
      utilizationPct: 50,
      elapsedPct: 60,
      projectedPct: null,
      paceMarginPct: 10,
      status: 'on_pace',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      jobCount: 5,
      recordedAt: now / 1000,
    });

    const req = new Request('http://localhost:3000/api/stats/usage-history?hours=48');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json() as any;

    expect(json.series).toHaveLength(1);
    const series = json.series[0];
    expect(series).toHaveProperty('provider', 'claude');
    expect(series).toHaveProperty('windowKey', '7d');
    expect(series).toHaveProperty('buckets');
    expect(Array.isArray(series.buckets)).toBe(true);
    expect(series).toHaveProperty('currentTokensPerHour');
    expect(series).toHaveProperty('expectedTokensPerHour');
    expect(series).toHaveProperty('catchUpTokensPerHour');
  });

  it('aggregates token totals correctly', async () => {
    const now = Date.now();
    const bucketTs = now - 60 * 60 * 1000;

    await sharedHandle.db.insert(schema.usageHourlySnapshot).values({
      bucketTs,
      provider: 'claude',
      windowKey: '7d',
      utilizationPct: 50,
      elapsedPct: 60,
      projectedPct: null,
      paceMarginPct: 10,
      status: 'on_pace',
      inputTokens: 4000,
      outputTokens: 1000,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      jobCount: 5,
      recordedAt: now / 1000,
    });

    const req = new Request('http://localhost:3000/api/stats/usage-history?hours=48');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json() as any;

    const series = json.series[0];
    const bucket: UsageHistoryBucket = series.buckets[0];
    expect(bucket).toHaveProperty('totalTokens');
    expect(bucket.totalTokens).toBe((4000 + 1000) * 4);
  });

  it('filters data by time window', async () => {
    const now = Date.now();
    const old = now - 100 * 60 * 60 * 1000;
    const recent = now - 24 * 60 * 60 * 1000;

    await sharedHandle.db.insert(schema.usageHourlySnapshot).values([
      {
        bucketTs: old,
        provider: 'claude',
        windowKey: '7d',
        utilizationPct: 50,
        elapsedPct: 60,
        projectedPct: null,
        paceMarginPct: 10,
        status: 'on_pace',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        jobCount: 5,
        recordedAt: old / 1000,
      },
      {
        bucketTs: recent,
        provider: 'claude',
        windowKey: '7d',
        utilizationPct: 50,
        elapsedPct: 60,
        projectedPct: null,
        paceMarginPct: 10,
        status: 'on_pace',
        inputTokens: 2000,
        outputTokens: 1000,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        jobCount: 10,
        recordedAt: recent / 1000,
      },
    ]);

    const req = new Request('http://localhost:3000/api/stats/usage-history?hours=48');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json() as any;

    const series = json.series[0];
    expect(series.buckets.length).toBe(1);
    expect(series.buckets[0].bucketTs).toBe(recent);
  });

  it('handles multiple providers and windows', async () => {
    const now = Date.now();
    const bucketTs = now - 60 * 60 * 1000;

    await sharedHandle.db.insert(schema.usageHourlySnapshot).values([
      {
        bucketTs,
        provider: 'claude',
        windowKey: '7d',
        utilizationPct: 50,
        elapsedPct: 60,
        projectedPct: null,
        paceMarginPct: 10,
        status: 'on_pace',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        jobCount: 5,
        recordedAt: now / 1000,
      },
      {
        bucketTs,
        provider: 'codex',
        windowKey: '7d',
        utilizationPct: 30,
        elapsedPct: 60,
        projectedPct: null,
        paceMarginPct: 30,
        status: 'under_pace',
        inputTokens: 500,
        outputTokens: 200,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        jobCount: 2,
        recordedAt: now / 1000,
      },
    ]);

    const req = new Request('http://localhost:3000/api/stats/usage-history?hours=48');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json() as any;

    expect(json.series).toHaveLength(2);
    const providers = json.series.map((s: any) => s.provider).sort();
    expect(providers).toEqual(['claude', 'codex']);
  });
});
