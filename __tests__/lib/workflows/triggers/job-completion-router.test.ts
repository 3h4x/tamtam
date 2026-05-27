import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

// The consumer module imports '@/lib/db' for db+schema and dispatchReleaseAfterRun
// dynamically for the dispatch step. We swap db with the test PGlite handle
// and stub dispatchReleaseAfterRun so we can observe routing without
// actually starting a release workflow.
let sharedHandle: TestDbHandle;

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS job_completion_events (
      id serial PRIMARY KEY,
      job_id text NOT NULL,
      kind text NOT NULL,
      exit_code integer,
      project text NOT NULL,
      release_id text,
      gh_issue_number integer,
      emitted_at double precision NOT NULL,
      consumed_by text,
      consumed_at double precision
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS job_completion_events_job_id
      ON job_completion_events (job_id)
  `));
  await handle.db.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS job_completion_events_unconsumed
      ON job_completion_events (consumed_by, emitted_at)
  `));
}

function withTestDbAndStubs(opts: {
  dispatchedFor?: (jobId: string) => boolean;
  legacyFlagEnabled?: boolean;
  legacyFixCiFlagEnabled?: boolean;
  legacyAutoResumeFlagEnabled?: boolean;
  legacyAgentDrainFlagEnabled?: boolean;
  getJobKind?: string;
  getJobExitCode?: number;
  getJobFinishedAt?: number | null;
} = {}) {
  const dispatchReleaseAfterRun = vi.fn().mockImplementation(async (job: { id: string }) => ({
    dispatched: opts.dispatchedFor ? opts.dispatchedFor(job.id) : true,
    reason: 'stub',
  }));
  const dispatchReleaseAfterFixCi = vi.fn().mockImplementation(async (job: { id: string }) => ({
    dispatched: opts.dispatchedFor ? opts.dispatchedFor(job.id) : true,
    reason: 'stub',
  }));
  const maybeAutoResume = vi.fn().mockResolvedValue(undefined);

  vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
  vi.doMock('@/lib/jobs/job-storage', () => ({
    getJob: (id: string) => ({
      id,
      kind: opts.getJobKind ?? 'run',
      project: 'proj',
      exitCode: opts.getJobExitCode ?? 0,
      finishedAt: 'getJobFinishedAt' in opts ? opts.getJobFinishedAt : 123,
      ghIssueNumber: null,
    }),
  }));
  vi.doMock('@/lib/jobs/kinds', async () => {
    const actual = await vi.importActual<typeof import('@/lib/jobs/kinds')>('@/lib/jobs/kinds');
    return actual;
  });
  const drainNextAgentRun = vi.fn().mockResolvedValue(undefined);
  vi.doMock('@/lib/shared/config', () => ({
    getSettings: () => ({
      legacy_completion_hook_release_after_run_enabled: opts.legacyFlagEnabled ?? false,
      legacy_completion_hook_release_after_fix_ci_enabled: opts.legacyFixCiFlagEnabled ?? false,
      legacy_completion_hook_auto_resume_enabled: opts.legacyAutoResumeFlagEnabled ?? false,
      legacy_completion_hook_agent_drain_enabled: opts.legacyAgentDrainFlagEnabled ?? false,
    }),
  }));
  vi.doMock('@/lib/workflows/triggers/release-after-run', () => ({ dispatchReleaseAfterRun }));
  vi.doMock('@/lib/workflows/triggers/release-after-fix-ci', () => ({ dispatchReleaseAfterFixCi }));
  vi.doMock('@/lib/jobs/auto-resume', () => ({ maybeAutoResume }));
  vi.doMock('@/lib/agents/pending-agent-run', () => ({ drainNextAgentRun }));

  return { dispatchReleaseAfterRun, dispatchReleaseAfterFixCi, maybeAutoResume, drainNextAgentRun };
}

async function insertEvent(overrides: Partial<typeof schema.jobCompletionEvents.$inferInsert> = {}) {
  await sharedHandle.db.insert(schema.jobCompletionEvents).values({
    jobId: overrides.jobId ?? 'proj-run-1',
    kind: overrides.kind ?? 'run',
    exitCode: overrides.exitCode ?? 0,
    project: overrides.project ?? 'proj',
    releaseId: overrides.releaseId ?? null,
    ghIssueNumber: overrides.ghIssueNumber ?? null,
    emittedAt: overrides.emittedAt ?? Date.now() / 1000,
    consumedBy: overrides.consumedBy ?? null,
  });
}

describe('consumeJobCompletionEvents', () => {
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
    await sharedHandle.db.execute(sql.raw('TRUNCATE job_completion_events RESTART IDENTITY'));
  });
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('routes unconsumed run events to dispatchReleaseAfterRun and marks them consumed', async () => {
    const { dispatchReleaseAfterRun } = withTestDbAndStubs();
    await insertEvent({ jobId: 'proj-run-A' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(result.processed).toBe(1);
    expect(result.routed).toBe(1);
    expect(dispatchReleaseAfterRun).toHaveBeenCalledOnce();

    const rows = await sharedHandle.db.select().from(schema.jobCompletionEvents);
    expect(rows[0].consumedBy).toBe('job-completion-router');
    expect(rows[0].consumedAt).not.toBeNull();
  });

  it('skips already-consumed rows', async () => {
    const { dispatchReleaseAfterRun } = withTestDbAndStubs();
    await insertEvent({ jobId: 'proj-run-B', consumedBy: 'job-completion-router' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(result.processed).toBe(0);
    expect(dispatchReleaseAfterRun).not.toHaveBeenCalled();
  });

  it('processes oldest first', async () => {
    const { dispatchReleaseAfterRun } = withTestDbAndStubs();
    await insertEvent({ jobId: 'newer', emittedAt: 200 });
    await insertEvent({ jobId: 'older', emittedAt: 100 });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();

    const callOrder = dispatchReleaseAfterRun.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(callOrder).toEqual(['older', 'newer']);
  });

  it('does not dispatch while the legacy hook flag is on, but still marks consumed', async () => {
    const { dispatchReleaseAfterRun } = withTestDbAndStubs({ legacyFlagEnabled: true });
    await insertEvent({ jobId: 'proj-run-legacy' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(dispatchReleaseAfterRun).not.toHaveBeenCalled();
    expect(result.routed).toBe(0);
    expect(result.skipped).toBe(1);
    const rows = await sharedHandle.db.select().from(schema.jobCompletionEvents);
    expect(rows[0].consumedBy).toBe('job-completion-router');
  });

  it('routes failed run/agent events to auto-resume when its kill switch is off', async () => {
    const { maybeAutoResume, dispatchReleaseAfterRun } = withTestDbAndStubs({ getJobExitCode: 1 });
    await insertEvent({ jobId: 'proj-run-fail', exitCode: 1 });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();

    expect(maybeAutoResume).toHaveBeenCalledOnce();
    expect(dispatchReleaseAfterRun).not.toHaveBeenCalled();
  });

  it('routes failed events using the durable event exit code even when the cached job is stale', async () => {
    const { maybeAutoResume, dispatchReleaseAfterRun } = withTestDbAndStubs({
      getJobExitCode: 0,
      getJobFinishedAt: null,
    });
    await insertEvent({ jobId: 'proj-run-stale-cache-fail', exitCode: 1, emittedAt: 456 });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();

    expect(maybeAutoResume).toHaveBeenCalledOnce();
    expect(maybeAutoResume).toHaveBeenCalledWith(expect.objectContaining({
      id: 'proj-run-stale-cache-fail',
      exitCode: 1,
      finishedAt: 456,
    }));
    expect(dispatchReleaseAfterRun).not.toHaveBeenCalled();
  });

  it('skips auto-resume routing while its legacy hook flag is on', async () => {
    const { maybeAutoResume } = withTestDbAndStubs({
      getJobExitCode: 1,
      legacyAutoResumeFlagEnabled: true,
    });
    await insertEvent({ jobId: 'proj-run-fail-legacy', exitCode: 1 });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();

    expect(maybeAutoResume).not.toHaveBeenCalled();
  });

  it('dispatches release-after-run BEFORE draining the agent queue on agent successes', async () => {
    // Regression for "durable agent drain overtakes release": the legacy
    // lifecycle hook ran release-after-run first so startRelease could
    // acquire the project lock before the next queued agent fired. The
    // router must preserve that ordering.
    const { dispatchReleaseAfterRun, drainNextAgentRun } = withTestDbAndStubs({ getJobKind: 'agent:foo' });
    await insertEvent({ jobId: 'proj-agent:foo-ok', kind: 'agent:foo' });

    const callOrder: string[] = [];
    dispatchReleaseAfterRun.mockImplementation(async () => { callOrder.push('release-after-run'); return { dispatched: true, reason: 'stub' }; });
    drainNextAgentRun.mockImplementation(async () => { callOrder.push('agent-drain'); });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();

    expect(callOrder).toEqual(['release-after-run', 'agent-drain']);
  });

  it('drains the per-project agent queue on agent kinds when its kill switch is off', async () => {
    const { drainNextAgentRun } = withTestDbAndStubs({ getJobKind: 'agent:foo' });
    await insertEvent({ jobId: 'proj-agent:foo-1', kind: 'agent:foo' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();

    expect(drainNextAgentRun).toHaveBeenCalledWith('proj');
  });

  it('skips agent drain while its legacy hook flag is on', async () => {
    const { drainNextAgentRun } = withTestDbAndStubs({
      getJobKind: 'agent:foo',
      legacyAgentDrainFlagEnabled: true,
    });
    await insertEvent({ jobId: 'proj-agent:foo-skip', kind: 'agent:foo' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();

    expect(drainNextAgentRun).not.toHaveBeenCalled();
  });

  it('routes fix-ci events to dispatchReleaseAfterFixCi when its kill switch is off', async () => {
    const { dispatchReleaseAfterFixCi, dispatchReleaseAfterRun } = withTestDbAndStubs({ getJobKind: 'fix-ci' });
    await insertEvent({ jobId: 'proj-fix-ci-1', kind: 'fix-ci' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(result.routed).toBe(1);
    expect(dispatchReleaseAfterFixCi).toHaveBeenCalledOnce();
    expect(dispatchReleaseAfterRun).not.toHaveBeenCalled();
  });

  it('routes successful fix-ci events using the durable event exit code when the cache is stale', async () => {
    const { dispatchReleaseAfterFixCi } = withTestDbAndStubs({
      getJobKind: 'fix-ci',
      getJobExitCode: 1,
    });
    await insertEvent({ jobId: 'proj-fix-ci-stale-cache-ok', kind: 'fix-ci', exitCode: 0 });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(result.routed).toBe(1);
    expect(dispatchReleaseAfterFixCi).toHaveBeenCalledWith(expect.objectContaining({
      id: 'proj-fix-ci-stale-cache-ok',
      kind: 'fix-ci',
      exitCode: 0,
    }));
  });

  it('skips fix-ci dispatch while its legacy hook flag is on', async () => {
    const { dispatchReleaseAfterFixCi } = withTestDbAndStubs({
      getJobKind: 'fix-ci',
      legacyFixCiFlagEnabled: true,
    });
    await insertEvent({ jobId: 'proj-fix-ci-skip', kind: 'fix-ci' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(dispatchReleaseAfterFixCi).not.toHaveBeenCalled();
    expect(result.routed).toBe(0);
  });

  it('still marks event consumed when dispatch declines to dispatch', async () => {
    withTestDbAndStubs({ dispatchedFor: () => false });
    await insertEvent({ jobId: 'proj-run-C' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(result.processed).toBe(1);
    expect(result.routed).toBe(0);
    expect(result.skipped).toBe(1);

    const rows = await sharedHandle.db.select().from(schema.jobCompletionEvents);
    expect(rows[0].consumedBy).toBe('job-completion-router');
  });
});
