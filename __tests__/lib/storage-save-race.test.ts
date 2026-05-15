import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression test for the cascade #6 / cascade #7 bug:
 *
 *   start-test.ts calls saveToDb (via createJob), then mutates the job
 *   (logPath, pid), then calls saveToDb again (via updateJob). Both calls
 *   are fire-and-forget. With pg.Pool and ≥2 connections, the second call's
 *   query can race ahead, complete first, and the first call's eventual
 *   `onConflictDoUpdate` clobbers the second's payload with the stale
 *   snapshot — so logPath ends up NULL in the DB even though start-test
 *   wrote it. probe.ts then declares the job dead at the 30s spawn-grace.
 *
 * Fix: per-job-id chain. Second saveToDb for the same job awaits the first
 * before its insert/onConflictDoUpdate fires. Distinct jobs still parallel.
 */

describe('saveToDb per-job serialization', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('serializes back-to-back saves for the same job (second snapshot wins)', async () => {
    const order: string[] = [];

    // Mock @/lib/db with an `insert(...)` that resolves after a controllable
    // delay. Both calls go through the same path; the first one is slow,
    // the second one is fast. Without serialization the fast one races
    // ahead and the slow one's onConflictDoUpdate lands second, clobbering.
    let firstCallStarted = false;
    const fakeChain = (callTag: string) => {
      const chain = {
        values: (vals: { logPath?: string }) => {
          chain.lastValues = vals;
          return chain;
        },
        onConflictDoUpdate: ({ set }: { set: { logPath?: string } }) => {
          chain.lastSet = set;
          return chain;
        },
        execute: async () => {
          // First call sleeps; second call resolves immediately.
          if (callTag === 'first') {
            firstCallStarted = true;
            await new Promise((r) => setTimeout(r, 30));
          } else {
            await Promise.resolve();
          }
          order.push(`${callTag}:logPath=${chain.lastSet?.logPath ?? chain.lastValues?.logPath ?? 'NONE'}`);
        },
        lastValues: undefined as { logPath?: string } | undefined,
        lastSet: undefined as { logPath?: string } | undefined,
      };
      return chain;
    };

    let callCount = 0;
    vi.doMock('@/lib/db', () => ({
      db: {
        insert: () => fakeChain(callCount++ === 0 ? 'first' : 'second'),
        select: () => ({ from: () => ({ all: () => [] }) }),
      },
      schema: {
        jobs: { id: 'id' },
      },
    }));

    const { saveToDb } = await import('@/lib/jobs/storage');

    const job1 = makeJob('job-A', null);
    const job2 = makeJob('job-A', '/tmp/test.log');

    saveToDb(job1);
    saveToDb(job2);

    // Wait for both queued ops to drain.
    await new Promise((r) => setTimeout(r, 60));

    expect(firstCallStarted).toBe(true);
    // The first save (with logPath=null) must complete BEFORE the second
    // (with logPath=/tmp/test.log) — no clobbering.
    expect(order).toEqual([
      'first:logPath=NONE',  // values payload doesn't carry logPath when null in our minimal stub
      'second:logPath=/tmp/test.log',
    ]);
  });

  it('does NOT serialize across distinct jobs', async () => {
    const startTimes: Record<string, number> = {};
    const t0 = Date.now();
    let callCount = 0;
    const fakeChain = (jobId: string) => {
      const chain = {
        values: (v: unknown) => chain,
        onConflictDoUpdate: () => chain,
        execute: async () => {
          startTimes[jobId] = Date.now() - t0;
          await new Promise((r) => setTimeout(r, 50));
        },
      };
      return chain;
    };
    vi.doMock('@/lib/db', () => ({
      db: { insert: () => fakeChain(`job-${callCount++}`), select: () => ({ from: () => ({ all: () => [] }) }) },
      schema: { jobs: { id: 'id' } },
    }));
    const { saveToDb } = await import('@/lib/jobs/storage');
    saveToDb(makeJob('job-X', null));
    saveToDb(makeJob('job-Y', null));
    await new Promise((r) => setTimeout(r, 80));
    // Both writes started within ~10ms of each other (same tick), not
    // serialized 50ms apart.
    expect(Math.abs(startTimes['job-0'] - startTimes['job-1'])).toBeLessThan(20);
  });
});

function makeJob(id: string, logPath: string | null) {
  return {
    id,
    project: 'p',
    kind: 'test',
    prompt: null,
    pid: 0,
    logPath,
    startedAt: 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    sessionId: null,
  } as unknown as import('@/lib/jobs/types').JobData;
}
