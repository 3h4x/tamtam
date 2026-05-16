import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestPgDb } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

async function withTestDbAndStubs(opts: { legacyInlineDrainEnabled?: boolean } = {}) {
  const handle = await createTestPgDb();
  const drainProjectRecoveryWork = vi.fn().mockResolvedValue(undefined);
  const drainNextAgentRun = vi.fn().mockResolvedValue(undefined);

  vi.doMock('@/lib/db', () => ({ db: handle.db, schema }));
  vi.doMock('@/lib/shared/config', () => ({
    getSettings: () => ({
      legacy_pipeline_lock_inline_drain_enabled: opts.legacyInlineDrainEnabled ?? false,
    }),
  }));
  vi.doMock('@/lib/pipeline/recovery-drain', () => ({ drainProjectRecoveryWork }));
  vi.doMock('@/lib/agents/pending-agent-run', () => ({ drainNextAgentRun }));

  return { handle, drainProjectRecoveryWork, drainNextAgentRun };
}

async function insertEvent(handle: Awaited<ReturnType<typeof createTestPgDb>>, overrides: Partial<typeof schema.pipelineLockEvents.$inferInsert> = {}) {
  await handle.db.insert(schema.pipelineLockEvents).values({
    project: overrides.project ?? 'proj',
    releasedByJobId: overrides.releasedByJobId ?? 'release-1',
    reason: overrides.reason ?? 'released',
    emittedAt: overrides.emittedAt ?? Date.now() / 1000,
    consumedBy: overrides.consumedBy ?? null,
  });
}

describe('consumePipelineLockEvents', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('drains recovery + agent queues for each unconsumed event when kill switch is off', async () => {
    const { handle, drainProjectRecoveryWork, drainNextAgentRun } = await withTestDbAndStubs();
    await insertEvent(handle, { project: 'proj' });

    const { consumePipelineLockEvents } = await import('@/lib/workflows/triggers/pipeline-lock-router');
    const result = await consumePipelineLockEvents();

    expect(result.drained).toBe(1);
    expect(drainProjectRecoveryWork).toHaveBeenCalledWith('proj', '[pipeline-lock-router]');
    expect(drainNextAgentRun).toHaveBeenCalledWith('proj');

    const rows = await handle.db.select().from(schema.pipelineLockEvents);
    expect(rows[0].consumedBy).toBe('pipeline-lock-router');
    await handle[Symbol.asyncDispose]();
  });

  it('collapses multiple events for the same project into a single drain', async () => {
    const { handle, drainProjectRecoveryWork } = await withTestDbAndStubs();
    await insertEvent(handle, { project: 'proj', emittedAt: 100 });
    await insertEvent(handle, { project: 'proj', emittedAt: 200 });
    await insertEvent(handle, { project: 'proj', emittedAt: 300 });

    const { consumePipelineLockEvents } = await import('@/lib/workflows/triggers/pipeline-lock-router');
    const result = await consumePipelineLockEvents();

    expect(result.processed).toBe(3);
    expect(result.drained).toBe(1);
    expect(drainProjectRecoveryWork).toHaveBeenCalledTimes(1);
    await handle[Symbol.asyncDispose]();
  });

  it('skips drain (but still marks consumed) while legacy inline-drain flag is on', async () => {
    const { handle, drainProjectRecoveryWork } = await withTestDbAndStubs({ legacyInlineDrainEnabled: true });
    await insertEvent(handle, { project: 'proj' });

    const { consumePipelineLockEvents } = await import('@/lib/workflows/triggers/pipeline-lock-router');
    const result = await consumePipelineLockEvents();

    expect(result.drained).toBe(0);
    expect(drainProjectRecoveryWork).not.toHaveBeenCalled();
    const rows = await handle.db.select().from(schema.pipelineLockEvents);
    expect(rows[0].consumedBy).toBe('pipeline-lock-router');
    await handle[Symbol.asyncDispose]();
  });

  it('drains per-project across multiple projects in one tick', async () => {
    const { handle, drainProjectRecoveryWork } = await withTestDbAndStubs();
    await insertEvent(handle, { project: 'a', emittedAt: 100 });
    await insertEvent(handle, { project: 'b', emittedAt: 200 });

    const { consumePipelineLockEvents } = await import('@/lib/workflows/triggers/pipeline-lock-router');
    const result = await consumePipelineLockEvents();

    expect(result.drained).toBe(2);
    expect(drainProjectRecoveryWork).toHaveBeenCalledTimes(2);
    await handle[Symbol.asyncDispose]();
  });
});
