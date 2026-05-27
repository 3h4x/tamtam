import { describe, it, expect, vi } from 'vitest';
import {
  handleUsageSnapshot,
  createUsageSnapshotTask,
  USAGE_SNAPSHOT_INTERVAL_MS,
  USAGE_SNAPSHOT_BUCKET_MS,
  type UsageSnapshotDeps,
  type UsageSnapshotRow,
  type TokenAggregate,
} from '@/lib/workflows/cron/usage-snapshot-task';

const NOW = 1_700_000_000_000;
// Expected bucket start for NOW
const BUCKET_TS = Math.floor(NOW / USAGE_SNAPSHOT_BUCKET_MS) * USAGE_SNAPSHOT_BUCKET_MS;

function makeProviderBridge(provider = 'anthropic') {
  return {
    provider,
    fiveHour: {
      utilizationPct: 60,
      elapsedPct: 50,
      projectedPct: 70,
      paceMarginPct: 15,
      status: 'on_pace',
    },
    sevenDay: {
      utilizationPct: 45,
      elapsedPct: 40,
      projectedPct: 50,
      paceMarginPct: 25,
      status: 'under_pace',
    },
  };
}

function makeDeps(overrides: Partial<UsageSnapshotDeps> = {}): UsageSnapshotDeps {
  return {
    loadBridge: vi.fn(async () => ({
      globalPace: { providers: [makeProviderBridge()] },
    })),
    upsertSnapshots: vi.fn(async () => {}),
    loadTokenAggregates: vi.fn(async () => new Map<string, TokenAggregate>()),
    enqueueNextFire: vi.fn(async () => {}),
    now: () => NOW,
    ...overrides,
  };
}

describe('handleUsageSnapshot', () => {
  it('writes 2 rows per provider (5h + 7d) and re-enqueues', async () => {
    const captured: UsageSnapshotRow[][] = [];
    const deps = makeDeps({
      upsertSnapshots: vi.fn(async (rows) => { captured.push(rows); }),
    });
    const r = await handleUsageSnapshot(deps);
    expect(r.written).toBe(2);
    expect(r.error).toBeUndefined();
    expect(captured).toHaveLength(1);
    const rows = captured[0];
    expect(rows.map((x) => x.windowKey).sort()).toEqual(['5h', '7d']);
    expect(rows[0].bucketTs).toBe(BUCKET_TS);
    expect(deps.enqueueNextFire).toHaveBeenCalledTimes(1);
  });

  it('writes 4 rows for two providers', async () => {
    const deps = makeDeps({
      loadBridge: vi.fn(async () => ({
        globalPace: {
          providers: [makeProviderBridge('anthropic'), makeProviderBridge('openai')],
        },
      })),
    });
    const r = await handleUsageSnapshot(deps);
    expect(r.written).toBe(4);
  });

  it('schedules next fire at now + interval', async () => {
    const deps = makeDeps();
    const r = await handleUsageSnapshot(deps);
    expect(r.nextFireAt.getTime()).toBe(NOW + USAGE_SNAPSHOT_INTERVAL_MS);
  });

  it('attaches token aggregates when the provider has completed jobs in bucket', async () => {
    const tokens: TokenAggregate = {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreateTokens: 10,
      jobCount: 3,
    };
    const captured: UsageSnapshotRow[][] = [];
    const deps = makeDeps({
      loadTokenAggregates: vi.fn(async () => new Map([['anthropic', tokens]])),
      upsertSnapshots: vi.fn(async (rows) => { captured.push(rows); }),
    });
    await handleUsageSnapshot(deps);
    const rows = captured[0];
    for (const row of rows) {
      expect(row.inputTokens).toBe(100);
      expect(row.jobCount).toBe(3);
    }
  });

  it('sets token fields to null when no jobs completed in bucket', async () => {
    const captured: UsageSnapshotRow[][] = [];
    const deps = makeDeps({
      loadTokenAggregates: vi.fn(async () => new Map()),
      upsertSnapshots: vi.fn(async (rows) => { captured.push(rows); }),
    });
    await handleUsageSnapshot(deps);
    for (const row of captured[0]) {
      expect(row.inputTokens).toBeNull();
      expect(row.jobCount).toBeNull();
    }
  });

  it('passes correct bucket window to loadTokenAggregates', async () => {
    const deps = makeDeps();
    await handleUsageSnapshot(deps);
    const [start, end] = (deps.loadTokenAggregates as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(start).toBe(BUCKET_TS);
    expect(end).toBe(BUCKET_TS + USAGE_SNAPSHOT_BUCKET_MS);
  });

  it('writes 0 rows and skips upsert when providers array is empty', async () => {
    const deps = makeDeps({
      loadBridge: vi.fn(async () => ({ globalPace: { providers: [] } })),
    });
    const r = await handleUsageSnapshot(deps);
    expect(r.written).toBe(0);
    expect(deps.upsertSnapshots).not.toHaveBeenCalled();
    expect(deps.enqueueNextFire).toHaveBeenCalledTimes(1);
  });

  it('captures loadBridge errors and still re-enqueues', async () => {
    const deps = makeDeps({
      loadBridge: vi.fn(async () => { throw new Error('quota api down'); }),
    });
    const r = await handleUsageSnapshot(deps);
    expect(r.error).toBe('quota api down');
    expect(r.written).toBe(0);
    expect(deps.enqueueNextFire).toHaveBeenCalledTimes(1);
  });
});

describe('createUsageSnapshotTask', () => {
  it('logs written count on success', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const task = createUsageSnapshotTask(makeDeps());
    await task({}, { logger } as never);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('wrote 2 rows'));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs error when snapshot fails', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const task = createUsageSnapshotTask(
      makeDeps({ loadBridge: vi.fn(async () => { throw new Error('bridge boom'); }) }),
    );
    await task({}, { logger } as never);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('bridge boom'));
  });
});
