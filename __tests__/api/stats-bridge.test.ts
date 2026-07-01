import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { JobData } from '@/lib/jobs/job-storage';
import * as schema from '@/lib/db/schema';
import { createTestPgDb, type TestDbHandle } from '@/__tests__/helpers/test-db';
import type { BridgeResponse } from '@/app/api/stats/bridge/route';

let sharedHandle: TestDbHandle;

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

function makeAgent(id: string, project: string, overrides: { enabled?: boolean; kind?: string } = {}) {
  return {
    id,
    name: id,
    project,
    skillIds: '[]',
    model: 'normal',
    prompt: '',
    schedule: null,
    enabled: overrides.enabled ?? true,
    docPaths: '[]',
    provider: null,
    fallbackEnabled: false,
    prerequisiteCommand: null,
    kind: overrides.kind ?? 'user',
    createdAt: Date.now() / 1000,
    updatedAt: Date.now() / 1000,
  };
}

describe('GET /api/stats/bridge', () => {
  let GET: typeof import('@/app/api/stats/bridge/route').GET;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let readEnabledProviderSnapshotsMock: ReturnType<typeof vi.fn>;
  let scheduledBurnRateBlockedAcrossProvidersMock: ReturnType<typeof vi.fn>;

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
    await sharedHandle.db.execute(sql`TRUNCATE agents, projects`);

    listJobsMock = vi.fn().mockReturnValue([]);
    readEnabledProviderSnapshotsMock = vi.fn().mockResolvedValue([]);
    scheduledBurnRateBlockedAcrossProvidersMock = vi.fn().mockReturnValue(null);

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/jobs/job-storage', () => ({ listJobs: listJobsMock }));
    vi.doMock('@/lib/shared/job-control', () => ({
      readEnabledProviderSnapshots: readEnabledProviderSnapshotsMock,
      scheduledBurnRateBlockedAcrossProviders: scheduledBurnRateBlockedAcrossProvidersMock,
    }));

    const mod = await import('@/app/api/stats/bridge/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('returns a fleet response with status precedence and summary counts', async () => {
    const now = Date.now() / 1000;
    await sharedHandle.db.insert(schema.projects).values([
      { name: 'alpha', path: '/tmp/alpha', enabled: true, paused: true },
      { name: 'beta', path: '/tmp/beta', enabled: true, paused: true },
      { name: 'gamma', path: '/tmp/gamma', enabled: true, paused: false },
      { name: 'ship', path: '/tmp/ship', enabled: true, paused: false },
      { name: 'active', path: '/tmp/active', enabled: true, paused: false },
      { name: 'idle', path: '/tmp/idle', enabled: true, paused: false },
    ]);
    await sharedHandle.db.insert(schema.agents).values([
      makeAgent('alpha-1', 'alpha'),
      makeAgent('alpha-2', 'alpha'),
      makeAgent('alpha-disabled', 'alpha', { enabled: false }),
      makeAgent('alpha-system', 'alpha', { kind: 'system' }),
      makeAgent('beta-1', 'beta'),
      makeAgent('gamma-1', 'gamma'),
      makeAgent('ship-1', 'ship'),
      makeAgent('active-1', 'active'),
      makeAgent('idle-1', 'idle'),
    ]);
    listJobsMock.mockReturnValue([
      makeJob({ id: 'alpha-release', project: 'alpha', kind: 'release', startedAt: now - 100, finishedAt: null }),
      makeJob({ id: 'beta-push', project: 'beta', kind: 'push', startedAt: now - 200, finishedAt: now - 100, exitCode: 1 }),
      makeJob({ id: 'gamma-release', project: 'gamma', kind: 'release', startedAt: now - 500, finishedAt: now - 400, exitCode: 1 }),
      makeJob({ id: 'ship-push', project: 'ship', kind: 'push', startedAt: now - 900, finishedAt: now - 600, exitCode: 0 }),
      makeJob({ id: 'active-agent', project: 'active', kind: 'agent:writer', startedAt: now - 1_200, finishedAt: now - 1_100, exitCode: 0 }),
      makeJob({ id: 'idle-agent', project: 'idle', kind: 'agent:writer', startedAt: now - 8_000, finishedAt: now - 7_900, exitCode: 0 }),
      makeJob({ id: 'ignored-push', project: 'no-agent', kind: 'push', startedAt: now - 10, finishedAt: now - 5, exitCode: 0 }),
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as BridgeResponse;
    const statuses = new Map(body.projects.map((project) => [project.project, project.status]));

    expect(body.generatedAt).toBe(Date.now());
    expect(body.projects).toHaveLength(6);
    expect(body.summary).toMatchObject({
      projects: 6,
      agentsEnabled: 7,
      releasing: 1,
      paused: 1,
      attention: 1,
      shipping: 1,
      active: 1,
      idle: 1,
      runningReleases: 1,
    });
    expect(statuses.get('alpha')).toBe('releasing');
    expect(statuses.get('beta')).toBe('paused');
    expect(statuses.get('gamma')).toBe('attention');
    expect(statuses.get('ship')).toBe('shipping');
    expect(statuses.get('active')).toBe('active');
    expect(statuses.get('idle')).toBe('idle');
    expect(body.projects.find((project) => project.project === 'alpha')?.agents).toBe(2);
  });

  it('excludes disabled projects even when they still have enabled agent rows', async () => {
    await sharedHandle.db.insert(schema.projects).values([
      { name: 'alive', path: '/tmp/alive', enabled: true, paused: false },
      { name: 'disabled', path: '/tmp/disabled', enabled: false, paused: false },
    ]);
    await sharedHandle.db.insert(schema.agents).values([
      makeAgent('alive-1', 'alive'),
      // Project is disabled but its agents are still 'enabled' on the row.
      // The bridge must NOT count these — otherwise disabled projects pollute
      // the fleet view and skew the "all projects shipped" / pace summaries.
      makeAgent('zombie-1', 'disabled'),
      makeAgent('zombie-2', 'disabled'),
    ]);

    const res = await GET();
    const body = await res.json() as BridgeResponse;

    expect(body.projects.map((p) => p.project)).toEqual(['alive']);
    expect(body.summary.projects).toBe(1);
    expect(body.summary.agentsEnabled).toBe(1);
  });

  it('counts only enabled, non-system DB agents per project', async () => {
    await sharedHandle.db.insert(schema.projects).values([
      { name: 'one', path: '/tmp/one', enabled: true, paused: false },
      { name: 'two', path: '/tmp/two', enabled: true, paused: false },
    ]);
    await sharedHandle.db.insert(schema.agents).values([
      makeAgent('one-a', 'one'),
      makeAgent('one-disabled', 'one', { enabled: false }),
      makeAgent('one-system', 'one', { kind: 'system' }),
      makeAgent('two-a', 'two'),
      makeAgent('two-b', 'two'),
    ]);

    const res = await GET();
    const body = await res.json() as BridgeResponse;
    const counts = new Map(body.projects.map((project) => [project.project, project.agents]));

    expect(body.projects).toHaveLength(2);
    expect(counts.get('one')).toBe(1);
    expect(counts.get('two')).toBe(2);
    expect(body.summary.agentsEnabled).toBe(3);
  });

  it('returns global pace and scheduler throttle payloads', async () => {
    const sevenDayMs = 7 * 24 * 60 * 60 * 1000;
    await sharedHandle.db.insert(schema.projects).values([
      { name: 'alpha', path: '/tmp/alpha', enabled: true, paused: false },
    ]);
    await sharedHandle.db.insert(schema.agents).values([makeAgent('alpha-1', 'alpha')]);
    readEnabledProviderSnapshotsMock.mockResolvedValue([
      {
        provider: 'claude',
        snapshot: {
          fiveHour: null,
          sevenDay: { utilization: 40, msUntilReset: sevenDayMs / 2 },
        },
      },
    ]);
    scheduledBurnRateBlockedAcrossProvidersMock.mockReturnValue({
      reason: '7d burn rate too high',
      projectedPct: 140,
      worstProvider: 'claude',
      resumesAtMs: 123_456,
    });

    const res = await GET();
    const body = await res.json() as BridgeResponse;

    expect(body.globalPace).toMatchObject({
      status: 'under_pace',
      bindingProvider: 'claude',
      bindingWindow: '7d',
      marginPct: 10,
      projectedPct: 80,
    });
    expect(body.globalPace.providers).toHaveLength(1);
    expect(body.globalPace.providers[0].sevenDay?.paceMarginPct).toBe(10);
    expect(body.throttle).toMatchObject({
      reason: '7d burn rate too high',
      projectedPct: 140,
      worstProvider: 'claude',
      resumesAtMs: 123_456,
    });
  });

  it('falls back to unknown pace and null throttle when quota helpers fail', async () => {
    await sharedHandle.db.insert(schema.projects).values([
      { name: 'alpha', path: '/tmp/alpha', enabled: true, paused: false },
    ]);
    await sharedHandle.db.insert(schema.agents).values([makeAgent('alpha-1', 'alpha')]);
    readEnabledProviderSnapshotsMock.mockRejectedValue(new Error('snapshot read failed'));
    scheduledBurnRateBlockedAcrossProvidersMock.mockImplementation(() => {
      throw new Error('throttle failed');
    });

    const res = await GET();
    const body = await res.json() as BridgeResponse;

    expect(body.globalPace).toMatchObject({
      status: 'unknown',
      bindingProvider: null,
      bindingWindow: null,
      marginPct: null,
      projectedPct: null,
      providers: [],
    });
    expect(body.throttle).toBeNull();
    expect(body.summary.projects).toBe(1);
  });
});
