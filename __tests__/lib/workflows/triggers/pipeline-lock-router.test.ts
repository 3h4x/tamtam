import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

let sharedHandle: TestDbHandle;

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS pipeline_lock_events (
      id serial PRIMARY KEY,
      project text NOT NULL,
      released_by_job_id text,
      reason text NOT NULL,
      emitted_at double precision NOT NULL,
      consumed_by text,
      consumed_at double precision
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS pipeline_lock_events_unconsumed
      ON pipeline_lock_events (consumed_by, emitted_at)
  `));
}

function withTestDbAndStubs(opts: { legacyInlineDrainEnabled?: boolean } = {}) {
  const drainProjectRecoveryWork = vi.fn().mockResolvedValue(undefined);
  const drainNextAgentRun = vi.fn().mockResolvedValue(undefined);

  vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
  vi.doMock('@/lib/shared/config', () => ({
    getSettings: () => ({
      legacy_pipeline_lock_inline_drain_enabled: opts.legacyInlineDrainEnabled ?? false,
    }),
  }));
  vi.doMock('@/lib/pipeline/recovery-drain', () => ({ drainProjectRecoveryWork }));
  vi.doMock('@/lib/agents/pending-agent-run', () => ({ drainNextAgentRun }));

  return { drainProjectRecoveryWork, drainNextAgentRun };
}

async function insertEvent(overrides: Partial<typeof schema.pipelineLockEvents.$inferInsert> = {}) {
  await sharedHandle.db.insert(schema.pipelineLockEvents).values({
    project: overrides.project ?? 'proj',
    releasedByJobId: overrides.releasedByJobId ?? 'release-1',
    reason: overrides.reason ?? 'released',
    emittedAt: overrides.emittedAt ?? Date.now() / 1000,
    consumedBy: overrides.consumedBy ?? null,
  });
}

describe('consumePipelineLockEvents', () => {
  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(() => vi.resetModules());
  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE pipeline_lock_events RESTART IDENTITY'));
  });
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('drains recovery + agent queues for each unconsumed event when kill switch is off', async () => {
    const { drainProjectRecoveryWork, drainNextAgentRun } = withTestDbAndStubs();
    await insertEvent({ project: 'proj' });

    const { consumePipelineLockEvents } = await import('@/lib/workflows/triggers/pipeline-lock-router');
    const result = await consumePipelineLockEvents();

    expect(result.drained).toBe(1);
    expect(drainProjectRecoveryWork).toHaveBeenCalledWith('proj', '[pipeline-lock-router]');
    expect(drainNextAgentRun).toHaveBeenCalledWith('proj');

    const rows = await sharedHandle.db.select().from(schema.pipelineLockEvents);
    expect(rows[0].consumedBy).toBe('pipeline-lock-router');
  });

  it('collapses multiple events for the same project into a single drain', async () => {
    const { drainProjectRecoveryWork } = withTestDbAndStubs();
    await insertEvent({ project: 'proj', emittedAt: 100 });
    await insertEvent({ project: 'proj', emittedAt: 200 });
    await insertEvent({ project: 'proj', emittedAt: 300 });

    const { consumePipelineLockEvents } = await import('@/lib/workflows/triggers/pipeline-lock-router');
    const result = await consumePipelineLockEvents();

    expect(result.processed).toBe(3);
    expect(result.drained).toBe(1);
    expect(drainProjectRecoveryWork).toHaveBeenCalledTimes(1);
  });

  it('skips drain (but still marks consumed) while legacy inline-drain flag is on', async () => {
    const { drainProjectRecoveryWork } = withTestDbAndStubs({ legacyInlineDrainEnabled: true });
    await insertEvent({ project: 'proj' });

    const { consumePipelineLockEvents } = await import('@/lib/workflows/triggers/pipeline-lock-router');
    const result = await consumePipelineLockEvents();

    expect(result.drained).toBe(0);
    expect(drainProjectRecoveryWork).not.toHaveBeenCalled();
    const rows = await sharedHandle.db.select().from(schema.pipelineLockEvents);
    expect(rows[0].consumedBy).toBe('pipeline-lock-router');
  });

  it('drains per-project across multiple projects in one tick', async () => {
    const { drainProjectRecoveryWork } = withTestDbAndStubs();
    await insertEvent({ project: 'a', emittedAt: 100 });
    await insertEvent({ project: 'b', emittedAt: 200 });

    const { consumePipelineLockEvents } = await import('@/lib/workflows/triggers/pipeline-lock-router');
    const result = await consumePipelineLockEvents();

    expect(result.drained).toBe(2);
    expect(drainProjectRecoveryWork).toHaveBeenCalledTimes(2);
  });
});
