import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/jobs/job-storage';
import { costUsd, totalTokens, PRICE_PER_MTOK } from '@/lib/shared/usage-pricing';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1',
    project: 'proj1',
    kind: 'run',
    prompt: null,
    pid: 1234,
    logPath: null,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    ...overrides,
  };
}

describe('GET /api/stats/usage', () => {
  let GET: any;
  let listJobsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    listJobsMock = vi.fn().mockReturnValue([]);
    vi.doMock('@/lib/jobs/job-storage', () => ({ listJobs: listJobsMock }));
    const mod = await import('@/app/api/stats/usage/route');
    GET = mod.GET;
  });

  afterEach(() => vi.resetModules());

  it('returns empty totals when no jobs', async () => {
    const res = await GET(new NextRequest('http://localhost/api/stats/usage'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projects).toEqual([]);
    expect(data.agents).toEqual([]);
    expect(data.totals.runs).toBe(0);
    expect(data.totals.costUsd).toBe(0);
    expect(data.window).toBe('30d');
    expect(data.pricing).toEqual(PRICE_PER_MTOK);
  });

  it('aggregates tokens and cost per project', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'a', project: 'p1', inputTokens: 1_000_000, outputTokens: 500_000 }),
      makeJob({ id: 'b', project: 'p1', cacheReadTokens: 2_000_000 }),
      makeJob({ id: 'c', project: 'p2', outputTokens: 100_000 }),
    ]);
    const res = await GET(new NextRequest('http://localhost/api/stats/usage'));
    const data = await res.json();
    expect(data.totals.runs).toBe(3);
    expect(data.projects).toHaveLength(2);

    const p1 = data.projects.find((r: any) => r.project === 'p1');
    expect(p1.runs).toBe(2);
    expect(p1.inputTokens).toBe(1_000_000);
    expect(p1.cacheReadTokens).toBe(2_000_000);
    expect(p1.totalTokens).toBe(3_500_000);
    expect(p1.costUsd).toBeCloseTo(
      costUsd({ inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheCreateTokens: 0 }),
      6
    );
  });

  it('sorts projects by cost descending', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'a', project: 'cheap', outputTokens: 1000 }),
      makeJob({ id: 'b', project: 'pricey', outputTokens: 1_000_000 }),
      makeJob({ id: 'c', project: 'mid', outputTokens: 100_000 }),
    ]);
    const res = await GET(new NextRequest('http://localhost/api/stats/usage'));
    const data = await res.json();
    expect(data.projects.map((r: any) => r.project)).toEqual(['pricey', 'mid', 'cheap']);
  });

  it('filters by time window', async () => {
    const now = Date.now() / 1000;
    listJobsMock.mockReturnValue([
      makeJob({ id: 'recent', project: 'p1', startedAt: now - 60, outputTokens: 100 }),
      makeJob({ id: 'old', project: 'p1', startedAt: now - 8 * 24 * 3600, outputTokens: 100 }),
    ]);
    const res = await GET(new NextRequest('http://localhost/api/stats/usage?window=24h'));
    const data = await res.json();
    expect(data.totals.runs).toBe(1);
    expect(data.window).toBe('24h');
  });

  it('includes everything for window=all', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'ancient', project: 'p1', startedAt: 1, outputTokens: 100 }),
    ]);
    const res = await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));
    const data = await res.json();
    expect(data.totals.runs).toBe(1);
  });

  it('falls back to 30d for invalid window param', async () => {
    const res = await GET(new NextRequest('http://localhost/api/stats/usage?window=bogus'));
    const data = await res.json();
    expect(data.window).toBe('30d');
  });

  it('reports lastRunAt as the most recent startedAt', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'a', project: 'p1', startedAt: 1000 }),
      makeJob({ id: 'b', project: 'p1', startedAt: 2000 }),
      makeJob({ id: 'c', project: 'p1', startedAt: 1500 }),
    ]);
    const res = await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));
    const data = await res.json();
    expect(data.projects[0].lastRunAt).toBe(2000);
  });

  it('returns agents breakdown grouped by kind sorted by cost', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'a', project: 'p1', kind: 'review', outputTokens: 500_000 }),
      makeJob({ id: 'b', project: 'p1', kind: 'review', outputTokens: 100_000 }),
      makeJob({ id: 'c', project: 'p2', kind: 'fix', outputTokens: 200_000 }),
      makeJob({ id: 'd', project: 'p1', kind: 'agent:cto', outputTokens: 1_000_000 }),
    ]);
    const res = await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));
    const data = await res.json();
    expect(data.agents.length).toBe(3);
    const kinds = data.agents.map((r: any) => r.kind);
    expect(kinds[0]).toBe('agent:cto');
    const reviewRow = data.agents.find((r: any) => r.kind === 'review');
    expect(reviewRow.runs).toBe(2);
    expect(reviewRow.outputTokens).toBe(600_000);
  });

  it('aggregates avgPromptBytes / avgPromptTokens per agent kind', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'a', project: 'p1', kind: 'review', promptBytes: 1000 }),
      makeJob({ id: 'b', project: 'p1', kind: 'review', promptBytes: 3000 }),
      makeJob({ id: 'c', project: 'p2', kind: 'review', promptBytes: 2000 }),
      makeJob({ id: 'd', project: 'p1', kind: 'fix', promptBytes: null }),
      makeJob({ id: 'e', project: 'p1', kind: 'fix', promptBytes: 0 }),
    ]);
    const res = await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));
    const data = await res.json();
    const review = data.agents.find((r: any) => r.kind === 'review');
    expect(review.promptSamples).toBe(3);
    expect(review.avgPromptBytes).toBe(2000);
    expect(review.avgPromptTokens).toBe(500);

    const fix = data.agents.find((r: any) => r.kind === 'fix');
    expect(fix.promptSamples).toBe(0);
    expect(fix.avgPromptBytes).toBeNull();
    expect(fix.avgPromptTokens).toBeNull();
  });

  it('treats null token fields as zero', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'a', project: 'p1', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreateTokens: null }),
    ]);
    const res = await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));
    const data = await res.json();
    expect(data.totals.totalTokens).toBe(0);
    expect(data.totals.costUsd).toBe(0);
    expect(data.projects[0].runs).toBe(1);
  });

  it('counts commitProducingRuns for commit jobs with exitCode 0 only', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'a', project: 'p1', kind: 'commit', exitCode: 0 }),
      makeJob({ id: 'b', project: 'p1', kind: 'commit', exitCode: 0 }),
      makeJob({ id: 'c', project: 'p1', kind: 'commit', exitCode: 1 }),
      makeJob({ id: 'd', project: 'p1', kind: 'commit', exitCode: null }),
      makeJob({ id: 'e', project: 'p1', kind: 'review', exitCode: 0 }),
    ]);
    const res = await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));
    const data = await res.json();
    const commit = data.agents.find((r: any) => r.kind === 'commit');
    expect(commit.runs).toBe(4);
    expect(commit.commitProducingRuns).toBe(2);
  });

  it('commitProducingRuns is 0 for non-commit kinds', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'a', project: 'p1', kind: 'review', exitCode: 0 }),
      makeJob({ id: 'b', project: 'p1', kind: 'fix', exitCode: 0 }),
    ]);
    const res = await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));
    const data = await res.json();
    for (const row of data.agents) {
      expect(row.commitProducingRuns).toBe(0);
    }
  });
});

describe('GET /api/stats/usage — response caching', () => {
  let GET: any;
  let listJobsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    listJobsMock = vi.fn().mockReturnValue([]);
    vi.doMock('@/lib/jobs/job-storage', () => ({ listJobs: listJobsMock }));
    const mod = await import('@/app/api/stats/usage/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('returns cached response within TTL without re-querying listJobs', async () => {
    listJobsMock.mockReturnValue([makeJob({ id: 'a', project: 'p1' })]);

    await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));
    expect(listJobsMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000); // still within 60s TTL
    listJobsMock.mockReturnValue([]); // would return different data if called

    const res = await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));
    expect(listJobsMock).toHaveBeenCalledTimes(1); // cache hit, not re-queried

    const data = await res.json();
    expect(data.totals.runs).toBe(1); // stale cached value
  });

  it('re-queries after 60s TTL expires', async () => {
    listJobsMock.mockReturnValue([makeJob({ id: 'a', project: 'p1' })]);
    await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));
    expect(listJobsMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001); // past TTL

    listJobsMock.mockReturnValue([]);
    const res = await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));
    expect(listJobsMock).toHaveBeenCalledTimes(2); // re-queried

    const data = await res.json();
    expect(data.totals.runs).toBe(0); // fresh data
  });

  it('caches different windows independently', async () => {
    await GET(new NextRequest('http://localhost/api/stats/usage?window=24h'));
    await GET(new NextRequest('http://localhost/api/stats/usage?window=7d'));
    expect(listJobsMock).toHaveBeenCalledTimes(2); // separate cache entries

    await GET(new NextRequest('http://localhost/api/stats/usage?window=24h'));
    await GET(new NextRequest('http://localhost/api/stats/usage?window=7d'));
    expect(listJobsMock).toHaveBeenCalledTimes(2); // both hit cache
  });

  it('first call after expiry updates the cache for subsequent calls', async () => {
    listJobsMock.mockReturnValue([makeJob({ id: 'a', project: 'p1' })]);
    await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));

    vi.advanceTimersByTime(60_001); // expire the cache

    listJobsMock.mockReturnValue([makeJob({ id: 'b', project: 'p2' }), makeJob({ id: 'c', project: 'p2' })]);
    await GET(new NextRequest('http://localhost/api/stats/usage?window=all')); // re-populates cache
    expect(listJobsMock).toHaveBeenCalledTimes(2);

    // Third call within new TTL should hit cache again
    const res = await GET(new NextRequest('http://localhost/api/stats/usage?window=all'));
    expect(listJobsMock).toHaveBeenCalledTimes(2);
    const data = await res.json();
    expect(data.totals.runs).toBe(2); // from second population
  });
});

describe('costUsd helper', () => {
  it('matches the published rate card', () => {
    expect(
      costUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 })
    ).toBeCloseTo(PRICE_PER_MTOK.input, 6);
    expect(
      costUsd({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreateTokens: 0 })
    ).toBeCloseTo(PRICE_PER_MTOK.output, 6);
    expect(
      costUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreateTokens: 0 })
    ).toBeCloseTo(PRICE_PER_MTOK.cacheRead, 6);
    expect(
      costUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 1_000_000 })
    ).toBeCloseTo(PRICE_PER_MTOK.cacheWrite, 6);
  });
});

describe('totalTokens helper', () => {
  it('sums all four token categories', () => {
    expect(totalTokens({ inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheCreateTokens: 400 }))
      .toBe(1000);
  });

  it('returns 0 for all-zero input', () => {
    expect(totalTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }))
      .toBe(0);
  });

  it('handles large values without overflow', () => {
    const big = 10_000_000;
    expect(totalTokens({ inputTokens: big, outputTokens: big, cacheReadTokens: big, cacheCreateTokens: big }))
      .toBe(4 * big);
  });
});
