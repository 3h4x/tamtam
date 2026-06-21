import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import type { JobData } from '@/lib/jobs/types';
import { finalizeAbortedRelease, finalizeReleaseJob, getTestDb, insertJobsAndCache, insertProjectWithDevServer, jobsCache, makeJobRow, markDone, mocks, resetTestState, runCompletionHooks } from './lifecycle-fixtures';

// ─── reconcileStaleRelease ────────────────────────────────────────────────────
// ─── reconcileStaleRelease tests removed: function retired with chain-loop closure

describe('release dev-server cleanup', () => {
  beforeEach(async () => {
    await resetTestState();
  });

  it('stops a configured dev server when finalizeReleaseJob completes a release', async () => {
    const now = Date.now() / 1000;
    await insertProjectWithDevServer('proj');
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: 'release-normal',
        project: 'proj',
        kind: 'release',
        startedAt: now - 30,
      }),
    ]);

    const release = jobsCache.get('release-normal');
    if (!release) throw new Error('release not cached');
    await finalizeReleaseJob(release, 0);

    expect(mocks.hasActiveWorkForProject).toHaveBeenCalledWith('proj');
    expect(mocks.stopDevServer).toHaveBeenCalledWith('proj', {
      stopCommand: 'pnpm dev:stop',
      cwd: '/workspace/proj',
    });
  });

  it('stops a configured dev server when finalizeAbortedRelease completes a release', async () => {
    const now = Date.now() / 1000;
    await insertProjectWithDevServer('proj');
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: 'release-aborted',
        project: 'proj',
        kind: 'release',
        startedAt: now - 30,
      }),
    ]);

    const release = jobsCache.get('release-aborted');
    if (!release) throw new Error('release not cached');
    await finalizeAbortedRelease(release);

    expect(mocks.stopDevServer).toHaveBeenCalledWith('proj', {
      stopCommand: 'pnpm dev:stop',
      cwd: '/workspace/proj',
    });
  });

  it('stops a configured dev server when a release is marked done directly', async () => {
    const now = Date.now() / 1000;
    await insertProjectWithDevServer('proj');
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: 'release-direct',
        project: 'proj',
        kind: 'release',
        startedAt: now - 30,
      }),
    ]);

    const release = jobsCache.get('release-direct');
    if (!release) throw new Error('release not cached');
    await markDone(release, 1);

    expect(mocks.stopDevServer).toHaveBeenCalledWith('proj', {
      stopCommand: 'pnpm dev:stop',
      cwd: '/workspace/proj',
    });
  });

  it('keeps the dev server running when another active release or agent still owns the project', async () => {
    const now = Date.now() / 1000;
    mocks.hasActiveWorkForProject.mockResolvedValue(true);
    await insertProjectWithDevServer('proj');
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: 'release-normal',
        project: 'proj',
        kind: 'release',
        startedAt: now - 30,
      }),
    ]);

    const release = jobsCache.get('release-normal');
    if (!release) throw new Error('release not cached');
    await finalizeReleaseJob(release, 0);

    expect(mocks.hasActiveWorkForProject).toHaveBeenCalledWith('proj');
    expect(mocks.stopDevServer).not.toHaveBeenCalled();
  });
});

describe('runCompletionHooks abort cleanup', () => {
  function makeJob(kind: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id: `${kind}-job`,
      project: 'proj',
      kind,
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: now,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetTestState();
  });

  it('finalizes an aborted release after the inline step finishes late', async () => {
    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: 'release-timeout',
        project: 'proj',
        kind: 'release',
        startedAt: now - 60,
        abortedAt: now - 10,
      }),
      makeJobRow({
        id: 'commit-timeout',
        project: 'proj',
        kind: 'commit',
        releaseId: 'release-timeout',
        startedAt: now - 30,
        finishedAt: now - 1,
        exitCode: -3,
      }),
    ]);

    await runCompletionHooks(
      makeJob('commit', {
        id: 'commit-timeout',
        project: 'proj',
        releaseId: 'release-timeout',
        finishedAt: now - 1,
        exitCode: -3,
      }),
    );

    const row = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, 'release-timeout'))).at(0);
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(-3);
    expect(row?.abortedAt).not.toBeNull();
    expect(mocks.releaseLock).toHaveBeenCalledWith('proj', 'release-timeout');
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      event: 'release_aborted',
      project: 'proj',
      job_id: 'release-timeout',
    }));
  });
});

describe('orphan release lock release', () => {
  function makeReleaseJob(id: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind: 'release', prompt: null, pid: 0, logPath: null,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetTestState();
  });

  it('calls releaseLock with project and jobId when a release job completes', async () => {
    const job = makeReleaseJob('release-orphan');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.releaseLock).toHaveBeenCalledWith('proj', 'release-orphan');
  });

  it('does NOT call releaseLock for interactive run jobs', async () => {
    const job = makeReleaseJob('run-job-1', { kind: 'run' });
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    // Neither the pipeline-step path nor the release-kind guard applies to `run` jobs
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });
});

describe('workflow-driven release short-circuit', () => {
  beforeEach(async () => {
    await resetTestState();
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true, autoCommitEnabled: false, releaseAfterRun: false, prWorkflowEnabled: false,
    });
    mocks.getSettings.mockReturnValue({ fix_max_iterations: 3 });
  });

  it('skips startProjectReview when the release is workflow-driven (test → review chain)', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-workflow-driven';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: releaseId,
        project: 'proj',
        kind: 'release',
        startedAt: now - 60,
        // The legacy `workflowDriven: true` contextMeta stamp was retired;
        // the lifecycle short-circuit now gates on `releaseId` directly.
        contextMeta: null,
      }),
    ]);
    const testJob: JobData = {
      id: 'test-1', project: 'proj', kind: 'test', pid: 99999, logPath: null, prompt: null,
      startedAt: now - 30, finishedAt: null, exitCode: null, seen: false, durationMs: null,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreateTokens: null,
      sessionId: null, releaseId,
    } as JobData;
    await markDone(testJob, 0);
    expect(mocks.startProjectReview).not.toHaveBeenCalled();
  });

  // Note: the previous "workflowDriven flag" test family was removed when
  // the lifecycle short-circuit moved to gating on `releaseId` directly
  // (see lib/jobs/lifecycle.ts ~line 496). The release-linked job above
  // is short-circuited regardless of any contextMeta marker.

  it('does not affect jobs outside a release (no releaseId)', async () => {
    const now = Date.now() / 1000;
    // Standalone agent run — no releaseId — should never hit the workflow-driven guard.
    const agentJob: JobData = {
      id: 'agent-x', project: 'proj', kind: 'agent:tests', pid: 99999, logPath: null, prompt: null,
      startedAt: now - 30, finishedAt: null, exitCode: null, seen: false, durationMs: null,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreateTokens: null,
      sessionId: null, releaseId: null,
    } as JobData;
    await markDone(agentJob, 0);
    // Just asserts no crash. Agent runs don't trigger the chain anyway.
    expect(mocks.startProjectReview).not.toHaveBeenCalled();
  });
});
