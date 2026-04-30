import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/jobs/job-storage';

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
    ...overrides,
  };
}

function makeRelease(id: string, project: string, exitCode: number, startedAt: number, finishedAt: number): JobData {
  return makeJob({ id, project, kind: 'release', exitCode, startedAt, finishedAt, durationMs: (finishedAt - startedAt) * 1000 });
}

function makeReview(id: string, project: string, exitCode = 0, startedAt = Date.now() / 1000): JobData {
  return makeJob({ id, project, kind: 'review', exitCode, startedAt, finishedAt: startedAt + 30 });
}

function makeFix(id: string, project: string, startedAt: number): JobData {
  return makeJob({ id, project, kind: 'fix', exitCode: 0, startedAt, finishedAt: startedAt + 60 });
}

describe('GET /api/stats/pipeline', () => {
  let GET: (req: NextRequest) => Promise<Response>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let getVerdictMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    listJobsMock = vi.fn().mockReturnValue([]);
    getVerdictMock = vi.fn().mockReturnValue(null);
    getSettingsMock = vi.fn().mockReturnValue({
      review_verdict_rules: 'default rules',
      commit_style: 'conventional commits',
    });

    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      getVerdict: getVerdictMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: getSettingsMock }));

    const mod = await import('@/app/api/stats/pipeline/route');
    GET = mod.GET as typeof GET;
  });

  afterEach(() => vi.resetModules());

  it('returns empty metrics when no jobs', async () => {
    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.verdicts.total).toBe(0);
    expect(data.pipelineSuccess.total).toBe(0);
    expect(data.fixLoop.total).toBe(0);
    expect(data.projects).toEqual([]);
    expect(data.window).toBe('30d');
  });

  it('counts verdict distribution correctly', async () => {
    const now = Date.now() / 1000;
    const r1 = makeReview('r1', 'p1', 0, now - 10);
    const r2 = makeReview('r2', 'p1', 0, now - 20);
    const r3 = makeReview('r3', 'p1', 0, now - 30);
    const r4 = makeReview('r4', 'p1', 0, now - 40);
    listJobsMock.mockReturnValue([r1, r2, r3, r4]);
    getVerdictMock
      .mockReturnValueOnce('LGTM')
      .mockReturnValueOnce('NEEDS ATTENTION')
      .mockReturnValueOnce('DO NOT SHIP')
      .mockReturnValueOnce(null);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.verdicts.lgtm).toBe(1);
    expect(data.verdicts.needsAttention).toBe(1);
    expect(data.verdicts.doNotShip).toBe(1);
    expect(data.verdicts.parseFailed).toBe(1);
    expect(data.verdicts.total).toBe(4);
  });

  it('excludes non-zero exit review jobs from verdicts', async () => {
    const now = Date.now() / 1000;
    const failed = makeReview('r1', 'p1', 1, now - 10);
    listJobsMock.mockReturnValue([failed]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.verdicts.total).toBe(0);
    expect(getVerdictMock).not.toHaveBeenCalled();
  });

  it('computes pipeline success rate from release jobs', async () => {
    const now = Date.now() / 1000;
    listJobsMock.mockReturnValue([
      makeRelease('rel1', 'p1', 0, now - 300, now - 10),
      makeRelease('rel2', 'p1', 0, now - 600, now - 300),
      makeRelease('rel3', 'p1', 1, now - 900, now - 600),
    ]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.pipelineSuccess.total).toBe(3);
    expect(data.pipelineSuccess.succeeded).toBe(2);
    expect(data.pipelineSuccess.failed).toBe(1);
    expect(data.pipelineSuccess.rate).toBeCloseTo(2 / 3);
  });

  it('computes fix loop convergence', async () => {
    const now = Date.now() / 1000;
    const rel1 = makeRelease('rel1', 'p1', 0, now - 600, now - 300);
    const rel2 = makeRelease('rel2', 'p1', 1, now - 1200, now - 700);
    const fix1 = makeFix('fix1', 'p1', now - 500);
    const fix2a = makeFix('fix2a', 'p1', now - 1100);
    const fix2b = makeFix('fix2b', 'p1', now - 1000);
    const fix2c = makeFix('fix2c', 'p1', now - 900);
    listJobsMock.mockReturnValue([rel1, rel2, fix1, fix2a, fix2b, fix2c]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.fixLoop.total).toBe(2);
    expect(data.fixLoop.converged).toBe(1);
    expect(data.fixLoop.hitCap).toBe(1);
    expect(data.fixLoop.avgIterations).toBe(2);
  });

  it('computes step durations (median and p95)', async () => {
    const now = Date.now() / 1000;
    const reviews = [10_000, 20_000, 30_000, 40_000, 50_000].map((ms, i) =>
      makeJob({ id: `r${i}`, project: 'p1', kind: 'review', exitCode: 0, startedAt: now - 3600 + i, finishedAt: now - 3600 + i + ms / 1000, durationMs: ms }),
    );
    listJobsMock.mockReturnValue(reviews);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.stepDurations.review).toBeDefined();
    expect(data.stepDurations.review.count).toBe(5);
    expect(data.stepDurations.review.median).toBe(30_000);
    expect(data.stepDurations.review.p95).toBe(50_000);
  });

  it('computes MTTR from successful release durations', async () => {
    const now = Date.now() / 1000;
    listJobsMock.mockReturnValue([
      makeRelease('r1', 'p1', 0, now - 600, now - 540),   // 60s
      makeRelease('r2', 'p1', 0, now - 1200, now - 1080), // 120s
      makeRelease('r3', 'p1', 1, now - 1800, now - 1700), // failed — excluded
    ]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.mttr).not.toBeNull();
    expect(data.mttr.count).toBe(2);
    expect(data.mttr.median).toBe(60_000);
  });

  it('filters by time window', async () => {
    const now = Date.now() / 1000;
    listJobsMock.mockReturnValue([
      makeRelease('r1', 'p1', 0, now - 3600, now - 3500),          // within 24h
      makeRelease('r2', 'p1', 0, now - 9 * 24 * 3600, now - 9 * 24 * 3600 + 60), // older than 7d
    ]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=24h'));
    const data = await res.json();
    expect(data.pipelineSuccess.total).toBe(1);
    expect(data.window).toBe('24h');
  });

  it('filters by project', async () => {
    const now = Date.now() / 1000;
    listJobsMock.mockReturnValue([
      makeRelease('r1', 'proj-a', 0, now - 600, now - 540),
      makeRelease('r2', 'proj-b', 0, now - 700, now - 640),
    ]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all&project=proj-a'));
    const data = await res.json();
    expect(data.pipelineSuccess.total).toBe(1);
    expect(data.pipelineSuccess.succeeded).toBe(1);
    expect(data.project).toBe('proj-a');
    expect(data.projects).toEqual([]); // no per-project table when filtering by project
  });

  it('includes per-project table in global view', async () => {
    const now = Date.now() / 1000;
    listJobsMock.mockReturnValue([
      makeRelease('r1', 'pa', 0, now - 600, now - 540),
      makeRelease('r2', 'pb', 1, now - 700, now - 640),
    ]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.projects.length).toBe(2);
    const pa = data.projects.find((p: { project: string }) => p.project === 'pa');
    expect(pa.releases).toBe(1);
    expect(pa.successRate).toBe(1);
    expect(pa.reviewCount).toBe(0);
    expect(pa.lgtmRate).toBe(0);
  });

  it('distinguishes zero-lgtm-with-reviews from no-reviews in per-project table', async () => {
    const now = Date.now() / 1000;
    const rev = makeReview('rv1', 'pa', 0, now - 50);
    listJobsMock.mockReturnValue([
      makeRelease('r1', 'pa', 0, now - 600, now - 540),
      rev,
    ]);
    getVerdictMock.mockReturnValue('NEEDS ATTENTION');

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    const pa = data.projects.find((p: { project: string }) => p.project === 'pa');
    expect(pa.reviewCount).toBe(1);
    expect(pa.lgtmRate).toBe(0);
  });

  it('includes configSnapshot with verdict rules and commit style', async () => {
    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline'));
    const data = await res.json();
    expect(data.configSnapshot.verdictRules).toBe('default rules');
    expect(data.configSnapshot.commitStyle).toBe('conventional commits');
    expect(data.configSnapshot.maxFixIterations).toBe(3);
  });

  it('falls back to 30d for invalid window', async () => {
    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=bogus'));
    const data = await res.json();
    expect(data.window).toBe('30d');
  });
});

describe('GET /api/stats/pipeline — caching', () => {
  let GET: (req: NextRequest) => Promise<Response>;
  let listJobsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    listJobsMock = vi.fn().mockReturnValue([]);
    vi.doMock('@/lib/jobs/job-storage', () => ({ listJobs: listJobsMock, getVerdict: vi.fn().mockReturnValue(null) }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: vi.fn().mockReturnValue({ review_verdict_rules: '', commit_style: '' }) }));
    const mod = await import('@/app/api/stats/pipeline/route');
    GET = mod.GET as typeof GET;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('returns cached response within TTL', async () => {
    await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    expect(listJobsMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    expect(listJobsMock).toHaveBeenCalledTimes(1);
  });

  it('re-queries after TTL expires', async () => {
    await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    vi.advanceTimersByTime(60_001);
    await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    expect(listJobsMock).toHaveBeenCalledTimes(2);
  });

  it('caches window and project separately', async () => {
    await GET(new NextRequest('http://localhost/api/stats/pipeline?window=24h'));
    await GET(new NextRequest('http://localhost/api/stats/pipeline?window=7d'));
    await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all&project=p1'));
    expect(listJobsMock).toHaveBeenCalledTimes(3);

    await GET(new NextRequest('http://localhost/api/stats/pipeline?window=24h'));
    expect(listJobsMock).toHaveBeenCalledTimes(3);
  });
});
