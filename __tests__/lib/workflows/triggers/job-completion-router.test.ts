import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestPgDb } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

// The consumer module imports '@/lib/db' for db+schema and dispatchReleaseAfterRun
// dynamically for the dispatch step. We swap db with the test PGlite handle
// and stub dispatchReleaseAfterRun so we can observe routing without
// actually starting a release workflow.
async function withTestDbAndStubs(opts: {
  dispatchedFor?: (jobId: string) => boolean;
  legacyFlagEnabled?: boolean;
  legacyFixCiFlagEnabled?: boolean;
  legacyAutoResumeFlagEnabled?: boolean;
  legacyAgentDrainFlagEnabled?: boolean;
  getJobKind?: string;
  getJobExitCode?: number;
} = {}) {
  const handle = await createTestPgDb();
  const dispatchReleaseAfterRun = vi.fn().mockImplementation(async (job: { id: string }) => ({
    dispatched: opts.dispatchedFor ? opts.dispatchedFor(job.id) : true,
    reason: 'stub',
  }));
  const dispatchReleaseAfterFixCi = vi.fn().mockImplementation(async (job: { id: string }) => ({
    dispatched: opts.dispatchedFor ? opts.dispatchedFor(job.id) : true,
    reason: 'stub',
  }));
  const maybeAutoResume = vi.fn().mockResolvedValue(undefined);

  vi.doMock('@/lib/db', () => ({ db: handle.db, schema }));
  vi.doMock('@/lib/jobs/job-storage', () => ({
    getJob: (id: string) => ({
      id,
      kind: opts.getJobKind ?? 'run',
      project: 'proj',
      exitCode: opts.getJobExitCode ?? 0,
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

  return { handle, dispatchReleaseAfterRun, dispatchReleaseAfterFixCi, maybeAutoResume, drainNextAgentRun };
}

async function insertEvent(handle: Awaited<ReturnType<typeof createTestPgDb>>, overrides: Partial<typeof schema.jobCompletionEvents.$inferInsert> = {}) {
  await handle.db.insert(schema.jobCompletionEvents).values({
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
  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('routes unconsumed run events to dispatchReleaseAfterRun and marks them consumed', async () => {
    const { handle, dispatchReleaseAfterRun } = await withTestDbAndStubs();
    await insertEvent(handle, { jobId: 'proj-run-A' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(result.processed).toBe(1);
    expect(result.routed).toBe(1);
    expect(dispatchReleaseAfterRun).toHaveBeenCalledOnce();

    const rows = await handle.db.select().from(schema.jobCompletionEvents);
    expect(rows[0].consumedBy).toBe('job-completion-router');
    expect(rows[0].consumedAt).not.toBeNull();

    await handle[Symbol.asyncDispose]();
  });

  it('skips already-consumed rows', async () => {
    const { handle, dispatchReleaseAfterRun } = await withTestDbAndStubs();
    await insertEvent(handle, { jobId: 'proj-run-B', consumedBy: 'job-completion-router' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(result.processed).toBe(0);
    expect(dispatchReleaseAfterRun).not.toHaveBeenCalled();
    await handle[Symbol.asyncDispose]();
  });

  it('processes oldest first', async () => {
    const { handle, dispatchReleaseAfterRun } = await withTestDbAndStubs();
    await insertEvent(handle, { jobId: 'newer', emittedAt: 200 });
    await insertEvent(handle, { jobId: 'older', emittedAt: 100 });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();

    const callOrder = dispatchReleaseAfterRun.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(callOrder).toEqual(['older', 'newer']);
    await handle[Symbol.asyncDispose]();
  });

  it('does not dispatch while the legacy hook flag is on, but still marks consumed', async () => {
    const { handle, dispatchReleaseAfterRun } = await withTestDbAndStubs({ legacyFlagEnabled: true });
    await insertEvent(handle, { jobId: 'proj-run-legacy' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(dispatchReleaseAfterRun).not.toHaveBeenCalled();
    expect(result.routed).toBe(0);
    expect(result.skipped).toBe(1);
    const rows = await handle.db.select().from(schema.jobCompletionEvents);
    expect(rows[0].consumedBy).toBe('job-completion-router');
    await handle[Symbol.asyncDispose]();
  });

  it('routes failed run/agent events to auto-resume when its kill switch is off', async () => {
    const { handle, maybeAutoResume, dispatchReleaseAfterRun } = await withTestDbAndStubs({ getJobExitCode: 1 });
    await insertEvent(handle, { jobId: 'proj-run-fail', exitCode: 1 });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();

    expect(maybeAutoResume).toHaveBeenCalledOnce();
    expect(dispatchReleaseAfterRun).not.toHaveBeenCalled();
    await handle[Symbol.asyncDispose]();
  });

  it('skips auto-resume routing while its legacy hook flag is on', async () => {
    const { handle, maybeAutoResume } = await withTestDbAndStubs({
      getJobExitCode: 1,
      legacyAutoResumeFlagEnabled: true,
    });
    await insertEvent(handle, { jobId: 'proj-run-fail-legacy', exitCode: 1 });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();

    expect(maybeAutoResume).not.toHaveBeenCalled();
    await handle[Symbol.asyncDispose]();
  });

  it('drains the per-project agent queue on agent kinds when its kill switch is off', async () => {
    const { handle, drainNextAgentRun } = await withTestDbAndStubs({ getJobKind: 'agent:foo' });
    await insertEvent(handle, { jobId: 'proj-agent:foo-1', kind: 'agent:foo' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();

    expect(drainNextAgentRun).toHaveBeenCalledWith('proj');
    await handle[Symbol.asyncDispose]();
  });

  it('skips agent drain while its legacy hook flag is on', async () => {
    const { handle, drainNextAgentRun } = await withTestDbAndStubs({
      getJobKind: 'agent:foo',
      legacyAgentDrainFlagEnabled: true,
    });
    await insertEvent(handle, { jobId: 'proj-agent:foo-skip', kind: 'agent:foo' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();

    expect(drainNextAgentRun).not.toHaveBeenCalled();
    await handle[Symbol.asyncDispose]();
  });

  it('routes fix-ci events to dispatchReleaseAfterFixCi when its kill switch is off', async () => {
    const { handle, dispatchReleaseAfterFixCi, dispatchReleaseAfterRun } = await withTestDbAndStubs({ getJobKind: 'fix-ci' });
    await insertEvent(handle, { jobId: 'proj-fix-ci-1', kind: 'fix-ci' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(result.routed).toBe(1);
    expect(dispatchReleaseAfterFixCi).toHaveBeenCalledOnce();
    expect(dispatchReleaseAfterRun).not.toHaveBeenCalled();
    await handle[Symbol.asyncDispose]();
  });

  it('skips fix-ci dispatch while its legacy hook flag is on', async () => {
    const { handle, dispatchReleaseAfterFixCi } = await withTestDbAndStubs({
      getJobKind: 'fix-ci',
      legacyFixCiFlagEnabled: true,
    });
    await insertEvent(handle, { jobId: 'proj-fix-ci-skip', kind: 'fix-ci' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(dispatchReleaseAfterFixCi).not.toHaveBeenCalled();
    expect(result.routed).toBe(0);
    await handle[Symbol.asyncDispose]();
  });

  it('still marks event consumed when dispatch declines to dispatch', async () => {
    const { handle } = await withTestDbAndStubs({ dispatchedFor: () => false });
    await insertEvent(handle, { jobId: 'proj-run-C' });

    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    const result = await consumeJobCompletionEvents();

    expect(result.processed).toBe(1);
    expect(result.routed).toBe(0);
    expect(result.skipped).toBe(1);

    const rows = await handle.db.select().from(schema.jobCompletionEvents);
    expect(rows[0].consumedBy).toBe('job-completion-router');
    await handle[Symbol.asyncDispose]();
  });
});
