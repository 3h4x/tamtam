import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobData } from '@/lib/jobs/job-storage';

const originalMaxStepIterations = process.env.TAMTAM_MAX_STEP_ITERATIONS;
const originalLegacyMaxFixIterations = process.env.TAMTAM_MAX_FIX_ITERATIONS;
const originalStepWindowSeconds = process.env.TAMTAM_STEP_WINDOW_SECONDS;
const originalLegacyFixWindowSeconds = process.env.TAMTAM_FIX_WINDOW_SECONDS;

function restoreRecoveryBudgetEnv() {
  if (originalMaxStepIterations === undefined) delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  else process.env.TAMTAM_MAX_STEP_ITERATIONS = originalMaxStepIterations;
  if (originalLegacyMaxFixIterations === undefined) delete process.env.TAMTAM_MAX_FIX_ITERATIONS;
  else process.env.TAMTAM_MAX_FIX_ITERATIONS = originalLegacyMaxFixIterations;
  if (originalStepWindowSeconds === undefined) delete process.env.TAMTAM_STEP_WINDOW_SECONDS;
  else process.env.TAMTAM_STEP_WINDOW_SECONDS = originalStepWindowSeconds;
  if (originalLegacyFixWindowSeconds === undefined) delete process.env.TAMTAM_FIX_WINDOW_SECONDS;
  else process.env.TAMTAM_FIX_WINDOW_SECONDS = originalLegacyFixWindowSeconds;
}

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

// After fix-push was unified into the generic fix kind, a "push fix" is
// a fix job whose parentJobId points at a failed push. For these tests the
// parent ID isn't asserted, so we synthesize a placeholder.
function makePushFix(id: string, project: string, startedAt: number): JobData {
  return makeJob({ id, project, kind: 'fix', exitCode: 0, startedAt, finishedAt: startedAt + 60, parentJobId: `${id}-parent-push` });
}

function writeReleaseLog(dir: string, name: string, stopReason?: string): string {
  const path = join(dir, `${name}.log`);
  const lines = ['# release started'];
  if (stopReason) lines.push(`# release stopped — ${stopReason}`);
  lines.push('# release finished — exit 1');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

describe('GET /api/stats/pipeline', () => {
  let GET: (req: NextRequest) => Promise<Response>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let getVerdictMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;
  let openSyncMock: ReturnType<typeof vi.fn>;
  let readSyncMock: ReturnType<typeof vi.fn>;
  let closeSyncMock: ReturnType<typeof vi.fn>;
  let statSyncMock: ReturnType<typeof vi.fn>;
  let fstatSyncMock: ReturnType<typeof vi.fn>;
  let readFileSyncMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-stats-pipeline-'));
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
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      openSyncMock = vi.fn(actual.openSync);
      readSyncMock = vi.fn(actual.readSync);
      closeSyncMock = vi.fn(actual.closeSync);
      statSyncMock = vi.fn(actual.statSync);
      fstatSyncMock = vi.fn(actual.fstatSync);
      readFileSyncMock = vi.fn(actual.readFileSync);
      return {
        ...actual,
        openSync: openSyncMock,
        readSync: readSyncMock,
        closeSync: closeSyncMock,
        statSync: statSyncMock,
        fstatSync: fstatSyncMock,
        readFileSync: readFileSyncMock,
      };
    });

    const mod = await import('@/app/api/stats/pipeline/route');
    GET = mod.GET as typeof GET;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    restoreRecoveryBudgetEnv();
    vi.resetModules();
  });

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

  it('classifies logPruned review with no verdict as prunedMissingVerdict, not parseFailed', async () => {
    const now = Date.now() / 1000;
    // logPruned: true means the log was deleted by retention; getVerdict returns null
    // because there is no log to parse. This should count as prunedMissingVerdict,
    // not parseFailed (which implies the log exists but verdict text wasn't found).
    const pruned = { ...makeReview('r-pruned', 'p1', 0, now - 10), logPruned: true };
    listJobsMock.mockReturnValue([pruned]);
    getVerdictMock.mockReturnValue(null);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.verdicts.total).toBe(1);
    expect(data.verdicts.prunedMissingVerdict).toBe(1);
    expect(data.verdicts.parseFailed).toBe(0);
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
    const rel1 = {
      ...makeRelease('rel1', 'p1', 0, now - 600, now - 300),
      logPath: writeReleaseLog(tempDir, 'rel1'),
    };
    const rel2 = {
      ...makeRelease('rel2', 'p1', 1, now - 1200, now - 700),
      logPath: writeReleaseLog(tempDir, 'rel2', 'review cap reached for p1 (3/3) — unresolved NEEDS ATTENTION review, no re-review budget left'),
    };
    const fix1 = { ...makeFix('fix1', 'p1', now - 500), releaseId: 'rel1' };
    const fix2a = { ...makeFix('fix2a', 'p1', now - 1100), releaseId: 'rel2' };
    const fix2b = { ...makeFix('fix2b', 'p1', now - 1000), releaseId: 'rel2' };
    const fix2c = { ...makeFix('fix2c', 'p1', now - 900), releaseId: 'rel2' };
    listJobsMock.mockReturnValue([rel1, rel2, fix1, fix2a, fix2b, fix2c]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.fixLoop.total).toBe(2);
    expect(data.fixLoop.converged).toBe(1);
    expect(data.fixLoop.hitCap).toBe(1);
    expect(data.fixLoop.avgIterations).toBe(2);
  });

  it('memoizes each release stop-reason lookup within one response and avoids full-file reads', async () => {
    const now = Date.now() / 1000;
    const release = {
      ...makeRelease('rel-cache', 'p1', 1, now - 600, now - 300),
      logPath: writeReleaseLog(tempDir, 'rel-cache', 'review cap reached for p1 (3/3) — unresolved NEEDS ATTENTION review'),
    };
    const fix = { ...makeFix('fix-cache', 'p1', now - 500), releaseId: 'rel-cache' };
    listJobsMock.mockReturnValue([release, fix]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();

    expect(data.fixLoop.hitCap).toBe(1);
    expect(readFileSyncMock).not.toHaveBeenCalled();
    // Size lookup now binds to the open fd via fstatSync — see route comment.
    expect(fstatSyncMock).toHaveBeenCalledTimes(1);
    expect(openSyncMock).toHaveBeenCalledTimes(1);
    expect(readSyncMock).toHaveBeenCalledTimes(1);
    expect(closeSyncMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the release time window for legacy recovery rows without releaseId', async () => {
    const now = Date.now() / 1000;
    const release = {
      ...makeRelease('rel-legacy', 'legacy-proj', 1, now - 1200, now - 700),
      logPath: writeReleaseLog(tempDir, 'rel-legacy', 'fix-push cap reached for legacy-proj (2/2) — push still blocked by hook rejection'),
    };
    const legacyFix = { ...makeFix('legacy-fix', 'legacy-proj', now - 1100), releaseId: null };
    const legacyFixPush = { ...makePushFix('legacy-fix-push', 'legacy-proj', now - 1000), releaseId: null };
    listJobsMock.mockReturnValue([release, legacyFix, legacyFixPush]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.fixLoop.total).toBe(1);
    expect(data.fixLoop.converged).toBe(0);
    expect(data.fixLoop.hitCap).toBe(1);
    expect(data.fixLoop.avgIterations).toBe(2);
    const project = data.projects.find((p: { project: string }) => p.project === 'legacy-proj');
    expect(project).toMatchObject({
      releases: 1,
      successRate: 0,
      fixIterationsAvg: 2,
    });
  });

  it('counts a failed release as hitCap when review/test budget is exhausted below the old fix-count threshold', async () => {
    const now = Date.now() / 1000;
    const release = {
      ...makeRelease('rel-cap', 'p1', 1, now - 600, now - 300),
      logPath: writeReleaseLog(tempDir, 'rel-cap', 'test cap reached for p1 (3/3) — tests still failing, no re-test budget left'),
    };
    const fix = { ...makeFix('fix-cap', 'p1', now - 500), releaseId: 'rel-cap' };
    listJobsMock.mockReturnValue([release, fix]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.fixLoop.total).toBe(1);
    expect(data.fixLoop.converged).toBe(0);
    expect(data.fixLoop.hitCap).toBe(1);
    expect(data.fixLoop.avgIterations).toBe(1);
  });

  it('does not count raw fix volume as hitCap when the release stopped for another reason', async () => {
    const now = Date.now() / 1000;
    const release = {
      ...makeRelease('rel-no-cap', 'p1', 1, now - 1200, now - 700),
      logPath: writeReleaseLog(tempDir, 'rel-no-cap', 'push blocked: pre-push hook tests failed for p1'),
    };
    const fixes = [
      { ...makeFix('fix-a', 'p1', now - 1100), releaseId: 'rel-no-cap' },
      { ...makeFix('fix-b', 'p1', now - 1000), releaseId: 'rel-no-cap' },
      { ...makeFix('fix-c', 'p1', now - 900), releaseId: 'rel-no-cap' },
    ];
    listJobsMock.mockReturnValue([release, ...fixes]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.fixLoop.total).toBe(1);
    expect(data.fixLoop.converged).toBe(0);
    expect(data.fixLoop.hitCap).toBe(0);
    expect(data.fixLoop.avgIterations).toBe(3);
  });

  it('counts a failed release as hitCap when fix-push retries are exhausted', async () => {
    const now = Date.now() / 1000;
    const release = {
      ...makeRelease('rel-fix-push-cap', 'p1', 1, now - 1200, now - 700),
      logPath: writeReleaseLog(tempDir, 'rel-fix-push-cap', 'fix-push cap reached for p1 (2/2) — push still blocked by hook rejection'),
    };
    const fixPushes = [
      { ...makePushFix('fix-push-a', 'p1', now - 1100), releaseId: 'rel-fix-push-cap' },
      { ...makePushFix('fix-push-b', 'p1', now - 1000), releaseId: 'rel-fix-push-cap' },
    ];
    listJobsMock.mockReturnValue([release, ...fixPushes]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.fixLoop.total).toBe(1);
    expect(data.fixLoop.converged).toBe(0);
    expect(data.fixLoop.hitCap).toBe(1);
    expect(data.fixLoop.avgIterations).toBe(2);
  });

  it('counts fix-push-only recovery loops in the per-project table', async () => {
    const now = Date.now() / 1000;
    const release = {
      ...makeRelease('rel-fix-push-project', 'proj-fix-push', 1, now - 1200, now - 700),
      logPath: writeReleaseLog(tempDir, 'rel-fix-push-project', 'fix-push cap reached for proj-fix-push (2/2) — push still blocked by hook rejection'),
    };
    const fixPushes = [
      { ...makePushFix('proj-fix-push-a', 'proj-fix-push', now - 1100), releaseId: 'rel-fix-push-project' },
      { ...makePushFix('proj-fix-push-b', 'proj-fix-push', now - 1000), releaseId: 'rel-fix-push-project' },
    ];
    listJobsMock.mockReturnValue([release, ...fixPushes]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    const project = data.projects.find((p: { project: string }) => p.project === 'proj-fix-push');
    expect(project).toMatchObject({
      releases: 1,
      successRate: 0,
      fixIterationsAvg: 2,
    });
  });

  it('counts review/test cap exhaustion from persisted release context when the log was pruned', async () => {
    const now = Date.now() / 1000;
    const release = {
      ...makeRelease('rel-pruned-cap', 'proj-pruned-cap', 1, now - 1200, now - 700),
      logPath: null,
      logPruned: true,
      contextMeta: JSON.stringify({
        releaseStopReason: 'fix→test cap reached for proj-pruned-cap (3/3) — tests still need verification',
      }),
    };
    const fix = { ...makeFix('fix-pruned-cap', 'proj-pruned-cap', now - 1100), releaseId: 'rel-pruned-cap' };
    listJobsMock.mockReturnValue([release, fix]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();

    expect(data.fixLoop.total).toBe(1);
    expect(data.fixLoop.hitCap).toBe(1);
    expect(statSyncMock).not.toHaveBeenCalled();
    expect(openSyncMock).not.toHaveBeenCalled();
    expect(readSyncMock).not.toHaveBeenCalled();
    expect(closeSyncMock).not.toHaveBeenCalled();
    const project = data.projects.find((p: { project: string }) => p.project === 'proj-pruned-cap');
    expect(project).toMatchObject({
      releases: 1,
      successRate: 0,
      fixIterationsAvg: 1,
    });
  });

  it('counts fix-push cap exhaustion from persisted release context when the log was pruned', async () => {
    const now = Date.now() / 1000;
    const release = {
      ...makeRelease('rel-pruned-fix-push-cap', 'proj-pruned-fix-push', 1, now - 1200, now - 700),
      logPath: null,
      logPruned: true,
      contextMeta: JSON.stringify({
        releaseStopReason: 'fix-push cap reached for proj-pruned-fix-push (2/2) — push hook failures still need recovery',
      }),
    };
    const fixPushes = [
      { ...makePushFix('fix-push-pruned-a', 'proj-pruned-fix-push', now - 1100), releaseId: 'rel-pruned-fix-push-cap' },
      { ...makePushFix('fix-push-pruned-b', 'proj-pruned-fix-push', now - 1000), releaseId: 'rel-pruned-fix-push-cap' },
    ];
    listJobsMock.mockReturnValue([release, ...fixPushes]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();

    expect(data.fixLoop.total).toBe(1);
    expect(data.fixLoop.hitCap).toBe(1);
    expect(data.fixLoop.avgIterations).toBe(2);
    const project = data.projects.find((p: { project: string }) => p.project === 'proj-pruned-fix-push');
    expect(project).toMatchObject({
      releases: 1,
      successRate: 0,
      fixIterationsAvg: 2,
    });
  });

  it('computes step durations (median and p95)', async () => {
    const now = Date.now() / 1000;
    const reviews = [10_000, 20_000, 30_000, 40_000, 50_000].map((ms, i) =>
      makeJob({ id: `r${i}`, project: 'p1', kind: 'review', exitCode: 0, startedAt: now - 3600 + i, finishedAt: now - 3600 + i + ms / 1000, durationMs: ms }),
    );
    const releases = [
      makeRelease('rel-a', 'p1', 0, now - 900, now - 780),
      makeRelease('rel-b', 'p1', 0, now - 700, now - 610),
    ];
    const mergeWaits = [
      makeJob({ id: 'pw-1', project: 'p1', kind: 'pr-wait', exitCode: 0, startedAt: now - 200, finishedAt: now - 170, durationMs: 30_000 }),
    ];
    listJobsMock.mockReturnValue([...reviews, ...releases, ...mergeWaits]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();
    expect(data.stepDurations.review).toBeDefined();
    expect(data.stepDurations.review.count).toBe(5);
    expect(data.stepDurations.review.avg).toBe(30_000);
    expect(data.stepDurations.review.median).toBe(30_000);
    expect(data.stepDurations.review.p95).toBe(50_000);
    expect(data.stepDurations.release.avg).toBe(105_000);
    expect(data.stepDurations['pr-wait'].avg).toBe(30_000);
  });

  it('includes synthetic agent step from parentJobId trigger job', async () => {
    const now = Date.now() / 1000;
    // The release's parentJobId points to the triggering run, which is outside
    // the releaseId graph. computeStepDurations must look it up via parentJobId
    // to populate the synthetic `agent` step duration.
    const trigger = makeJob({ id: 'trigger-1', project: 'p1', kind: 'run', exitCode: 0, startedAt: now - 500, finishedAt: now - 200, durationMs: 300_000, costUsd: 0.5 });
    const release = { ...makeRelease('rel-1', 'p1', 0, now - 200, now - 100), parentJobId: 'trigger-1' };
    listJobsMock.mockReturnValue([trigger, release]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();

    expect(data.stepDurations.agent).toBeDefined();
    expect(data.stepDurations.agent.count).toBe(1);
    expect(data.stepDurations.agent.avg).toBe(300_000);
    expect(data.stepDurations.agent.avgCostUsd).toBe(0.5);
  });

  it('omits synthetic agent step when no release has a parentJobId', async () => {
    const now = Date.now() / 1000;
    listJobsMock.mockReturnValue([
      makeRelease('rel-no-parent', 'p1', 0, now - 300, now - 200),
    ]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();

    expect(data.stepDurations.agent).toBeUndefined();
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
    expect(data.mttr.avg).toBe(90_000);
    expect(data.mttr.median).toBe(60_000);
  });

  it('computes release cost separately for all finished releases vs successful releases only', async () => {
    const now = Date.now() / 1000;
    listJobsMock.mockReturnValue([
      makeRelease('rel-success-a', 'p1', 0, now - 1200, now - 1140),
      makeRelease('rel-success-b', 'p1', 0, now - 900, now - 810),
      makeRelease('rel-failed', 'p1', 1, now - 600, now - 510),
      makeJob({ id: 'test-a', project: 'p1', kind: 'test', exitCode: 0, startedAt: now - 1190, finishedAt: now - 1180, releaseId: 'rel-success-a', costUsd: 1 }),
      makeJob({ id: 'review-a', project: 'p1', kind: 'review', exitCode: 0, startedAt: now - 1180, finishedAt: now - 1170, releaseId: 'rel-success-a', costUsd: 2 }),
      makeJob({ id: 'test-b', project: 'p1', kind: 'test', exitCode: 0, startedAt: now - 890, finishedAt: now - 880, releaseId: 'rel-success-b', costUsd: 3 }),
      makeJob({ id: 'review-b', project: 'p1', kind: 'review', exitCode: 0, startedAt: now - 880, finishedAt: now - 870, releaseId: 'rel-success-b', costUsd: 5 }),
      makeJob({ id: 'test-failed', project: 'p1', kind: 'test', exitCode: 1, startedAt: now - 590, finishedAt: now - 580, releaseId: 'rel-failed', costUsd: 20 }),
    ]);

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline?window=all'));
    const data = await res.json();

    expect(data.mttr.avgCostUsd).toBe(5.5);
    expect(data.mttr.count).toBe(2);
    expect(data.stepDurations.release.avgCostUsd).toBe(10.3333);
    expect(data.stepDurations.release.count).toBe(3);
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
    expect(data.configSnapshot.maxStepIterations).toBe(3);
    expect(data.configSnapshot.maxPushFixAttempts).toBe(2);
    expect(data.configSnapshot.stepWindowSeconds).toBe(1800);
  });

  it('reads maxStepIterations from the shared recovery-budget env alias', async () => {
    process.env.TAMTAM_MAX_STEP_ITERATIONS = '5';
    delete process.env.TAMTAM_MAX_FIX_ITERATIONS;
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

    const res = await GET(new NextRequest('http://localhost/api/stats/pipeline'));
    const data = await res.json();
    expect(data.configSnapshot.maxStepIterations).toBe(5);
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
    restoreRecoveryBudgetEnv();
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
