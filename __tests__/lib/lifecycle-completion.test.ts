import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import type { JobData } from '@/lib/jobs/types';
import { getTestDb, insertJobsAndCache, makeJobRow, markDone, mocks, resetTestState } from './lifecycle-fixtures';

// ─── auto-mark seen on completion ────────────────────────────────────────────

describe('auto-mark seen on completion', () => {
  function makeInMemoryJob(id: string, kind: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind, prompt: null, pid: 0, logPath: null,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetTestState();
  });

  async function runMarkDone(job: JobData, exitCode: number): Promise<boolean> {
    await markDone(job, exitCode);
    const row = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, job.id))).at(0);
    return !!row?.seen;
  }

  it('auto-marks a successful pipeline child seen (commit / push / test)', async () => {
    for (const kind of ['commit', 'push', 'test', 'mark-dod']) {
      // Each iteration starts from a clean state so previous DB rows don't
      // leak into subsequent assertions.
      await resetTestState();
      const seen = await runMarkDone(makeInMemoryJob(`${kind}-ok`, kind), 0);
      expect(seen, `${kind} exit-0 should be auto-seen`).toBe(true);
    }
  });

  it('does NOT auto-mark a failed pipeline child seen', async () => {
    const seen = await runMarkDone(makeInMemoryJob('test-fail', 'test'), 1);
    expect(seen).toBe(false);
  });

  it('does not spawn a push-fix job for remote race failures', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tamtam-remote-race-'));
    try {
      const logPath = join(tempDir, 'push.log');
      writeFileSync(logPath, "remote: error: cannot lock ref 'refs/heads/main': is at aaa but expected bbb\n");
      mocks.isRemoteRaceRejection.mockReturnValue(true);

      const seen = await runMarkDone(makeInMemoryJob('push-remote-race', 'push', { logPath }), 1);

      expect(seen).toBe(false);
      expect(mocks.isRemoteRaceRejection).toHaveBeenCalled();
      expect(mocks.startFixFromJob).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does NOT auto-mark a release meta-job seen even on success', async () => {
    const seen = await runMarkDone(makeInMemoryJob('rel-ok', 'release'), 0);
    expect(seen).toBe(false);
  });

  it('does NOT auto-mark interactive `run` jobs seen', async () => {
    const seen = await runMarkDone(makeInMemoryJob('term-ok', 'run'), 0);
    expect(seen).toBe(false);
  });

  it('auto-marks an LGTM review seen but leaves NEEDS ATTENTION unseen', async () => {
    const lgtmLog = join(mkdtempSync(join(tmpdir(), 'amark-')), 'lgtm.log');
    writeFileSync(lgtmLog, 'Findings: none\nVerdict: LGTM\n');
    const seenLgtm = await runMarkDone(makeInMemoryJob('rev-lgtm', 'review', { logPath: lgtmLog }), 0);
    expect(seenLgtm).toBe(true);

    await resetTestState();
    const naLog = join(mkdtempSync(join(tmpdir(), 'amark-')), 'na.log');
    writeFileSync(naLog, 'Findings:\n- Finding ID: x\nVerdict: NEEDS ATTENTION\n');
    const seenNa = await runMarkDone(makeInMemoryJob('rev-na', 'review', { logPath: naLog }), 0);
    expect(seenNa).toBe(false);
  });

  it('auto-marks a no-op agent run (empty modifiedFiles) seen but keeps actionable runs unseen', async () => {
    const seenNoop = await runMarkDone(
      makeInMemoryJob('agent-noop', 'agent:improve', { modifiedFiles: '[]' }),
      0,
    );
    expect(seenNoop).toBe(true);

    await resetTestState();
    const seenActionable = await runMarkDone(
      makeInMemoryJob('agent-act', 'agent:improve', { modifiedFiles: '[{"path":"a.ts"}]' }),
      0,
    );
    expect(seenActionable).toBe(false);
  });

  it('keeps an agent run unseen when report extraction fails and modifiedFiles is missing', async () => {
    mocks.finalizeAgentRunReport.mockRejectedValueOnce(new Error('git status failed'));
    const seen = await runMarkDone(
      makeInMemoryJob('agent-report-fail', 'agent:improve', { modifiedFiles: null }),
      0,
    );
    expect(seen).toBe(false);
  });

  it('persists agent report fields before emitting the durable completion event', async () => {
    mocks.finalizeAgentRunReport.mockImplementationOnce(async (job: JobData) => {
      expect(job.finishedAt).not.toBeNull();
      job.workSummary = 'Changed the release gate.';
      job.modifiedFiles = JSON.stringify([{ path: 'lib/jobs/lifecycle.ts', status: 'M' }]);
      job.linesAdded = 12;
      job.linesRemoved = 3;
    });

    const job = makeInMemoryJob('agent-report-fields', 'agent:improve');
    await markDone(job, 0);

    const row = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, job.id))).at(0);
    expect(row).toMatchObject({
      finishedAt: expect.any(Number),
      workSummary: 'Changed the release gate.',
      modifiedFiles: JSON.stringify([{ path: 'lib/jobs/lifecycle.ts', status: 'M' }]),
      linesAdded: 12,
      linesRemoved: 3,
      runScore: 91,
    });

    const event = (await getTestDb().select().from(schema.jobCompletionEvents).where(eq(schema.jobCompletionEvents.jobId, job.id))).at(0);
    expect(event).toMatchObject({
      jobId: job.id,
      kind: 'agent:improve',
      exitCode: 0,
      project: 'proj',
    });
  });
});

describe('cancelled push completion', () => {
  let tempDir: string;

  beforeEach(async () => {
    await resetTestState();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-cancelled-push-'));
    mocks.isHookRejection.mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not treat a wall-clock-cancelled push as a hook rejection', async () => {
    const now = Date.now() / 1000;
    const pushLog = join(tempDir, 'push-cancelled.log');
    writeFileSync(pushLog, [
      '# push start',
      '$ git rev-list --count @{u}..HEAD',
      '1',
      '$ git push',
      '# push cancelled',
    ].join('\n'));

    const pushJob = makeJobRow({
      id: 'push-cancelled',
      project: 'proj',
      kind: 'push',
      logPath: pushLog,
      startedAt: now - 10,
    }) as unknown as JobData;

    await markDone(pushJob, -3);

    expect(mocks.isHookRejection).not.toHaveBeenCalled();
    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
  });
});

// ─── push → dod target selection ─────────────────────────────────────────────

describe('push → dod target selection', () => {
  const prContextMeta = JSON.stringify({ prNumber: 42, prRepo: 'owner/repo', prUrl: 'https://github.com/owner/repo/pull/42' });

  function makePushJob(id: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind: 'push', prompt: null, pid: 0, logPath: null,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetTestState();
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: false, autoCommitEnabled: false,
      releaseAfterRun: false, prWorkflowEnabled: false,
      autoPrMergeEnabled: false,
    });
  });

  it('uses issue target when ghIssueNumber and ghIssueRepo are set', async () => {
    const job = makePushJob('push-issue-dod', {
      exitCode: 0,
      contextMeta: prContextMeta,
      ghIssueNumber: 7,
      ghIssueRepo: 'owner/repo',
    });
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.startMarkDod).toHaveBeenCalledWith('proj', { issueNumber: 7, repo: 'owner/repo' });
  });

  it('falls back to PR target when ghIssueNumber is null', async () => {
    const job = makePushJob('push-pr-dod', {
      exitCode: 0,
      contextMeta: prContextMeta,
      ghIssueNumber: null,
      ghIssueRepo: null,
    });
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.startMarkDod).toHaveBeenCalledWith('proj', { prNumber: 42, repo: 'owner/repo' });
  });

  it('skips dod entirely when contextMeta has no prNumber', async () => {
    const job = makePushJob('push-no-meta-dod', {
      exitCode: 0,
      contextMeta: JSON.stringify({ message: 'pushed ok' }),
    });
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.startMarkDod).not.toHaveBeenCalled();
  });

  it('launches pr-wait and skips dod when autoPrMergeEnabled is true', async () => {
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: false, autoCommitEnabled: false,
      releaseAfterRun: false, prWorkflowEnabled: false,
      autoPrMergeEnabled: true,
    });

    const job = makePushJob('push-auto-merge', {
      exitCode: 0,
      contextMeta: prContextMeta,
      ghIssueNumber: 7,
      ghIssueRepo: 'owner/repo',
    });
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.launchPrWait).toHaveBeenCalledWith('proj', 42, 'owner/repo', 'https://github.com/owner/repo/pull/42', { allowWhilePaused: true });
    expect(mocks.startMarkDod).not.toHaveBeenCalled();
  });
});
