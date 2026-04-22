import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/job-storage';
import { costUsd, totalTokens, PRICE_PER_MTOK } from '@/lib/usage-pricing';

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
    vi.doMock('@/lib/job-storage', () => ({ listJobs: listJobsMock }));
    const mod = await import('@/app/api/stats/usage/route');
    GET = mod.GET;
  });

  afterEach(() => vi.resetModules());

  it('returns empty totals when no jobs', async () => {
    const res = await GET(new NextRequest('http://localhost/api/stats/usage'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projects).toEqual([]);
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
