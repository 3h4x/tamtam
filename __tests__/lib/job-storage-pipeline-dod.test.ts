import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sharedHandle } from './job-storage-pipeline-fixtures';

describe('runCompletionHooks – push→DoD (PR Workflow without auto-merge)', () => {
  let startMarkDodMock: ReturnType<typeof vi.fn>;
  let launchPrWaitMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let tempDir: string;
  let jobSeq = 0;

  function makeJob(kind: string, overrides: Partial<JobData> = {}): JobData {
    return {
      id: `${kind}-job-${++jobSeq}`,
      project: 'my-proj',
      kind,
      prompt: null,
      pid: 1,
      logPath: null,
      startedAt: Date.now() / 1000,
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

  let storageCache: Map<string, JobData>;

  beforeAll(async () => {
    vi.resetModules();
    startMarkDodMock = vi.fn();
    getProjectTestConfigMock = vi.fn();
    launchPrWaitMock = vi.fn();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) }));
    vi.doMock('@/lib/git/git-utils', () => ({ markReviewed: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue('/proj') }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: vi.fn() }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: vi.fn() }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: vi.fn() }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: vi.fn() }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({ startFixFromJob: vi.fn() }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));
    vi.doMock('@/lib/pipeline/start-mark-dod', () => ({ startMarkDod: startMarkDodMock }));
    vi.doMock('@/lib/pipeline/start-pr-wait', () => ({ launchPrWait: launchPrWaitMock }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-push-dod-test-'));
  });

  beforeEach(async () => {
    storageCache.clear();
    startMarkDodMock.mockReset().mockResolvedValue({ ok: true, verified: 2, total: 2, changed: true, issueNumber: 55 });
    getProjectTestConfigMock.mockReset().mockReturnValue({
      prWorkflowEnabled: true,
      autoPrMergeEnabled: false,
      autoPushEnabled: false,
    });
    launchPrWaitMock.mockReset().mockReturnValue({ jobId: 'prwait-1' });
  });

  afterAll(() => {
    if (tempDir) rmSync(/*turbopackIgnore: true*/ tempDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-test');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-commit');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/pipeline/start-mark-dod');
    vi.doUnmock('@/lib/pipeline/start-pr-wait');
    vi.resetModules();
  });

  it('calls startMarkDod when push succeeds with prWorkflowEnabled=true and contextMeta has prNumber', async () => {
    const job = makeJob('push', { contextMeta: JSON.stringify({ prNumber: 55, prRepo: 'owner/repo', prUrl: 'https://github.com/owner/repo/pull/55' }) });
    await markDoneFn(job, 0);
    expect(startMarkDodMock).toHaveBeenCalledWith('my-proj', {
      prNumber: 55,
      repo: 'owner/repo',
    });
  });

  it('does not call startMarkDod when push fails', async () => {
    const job = makeJob('push', { contextMeta: JSON.stringify({ prNumber: 55, prRepo: 'owner/repo' }) });
    await markDoneFn(job, 1);
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });

  it('calls startMarkDod in Direct Branch mode (prWorkflowEnabled=false) when push created a PR', async () => {
    // Issue-linked pushes create a PR even in Direct Branch mode; DoD should run.
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: false, autoPrMergeEnabled: false });
    const job = makeJob('push', { contextMeta: JSON.stringify({ prNumber: 55, prRepo: 'owner/repo' }) });
    await markDoneFn(job, 0);
    expect(startMarkDodMock).toHaveBeenCalledWith('my-proj', {
      prNumber: 55,
      repo: 'owner/repo',
    });
  });

  it('does not call startMarkDod when autoPrMergeEnabled=true (launchPrWait handles DoD post-merge)', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true, autoPrMergeEnabled: true });
    const job = makeJob('push', { contextMeta: JSON.stringify({ prNumber: 55, prRepo: 'owner/repo', prUrl: 'https://github.com/owner/repo/pull/55' }) });
    await markDoneFn(job, 0);
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });

  it('does not call startMarkDod when contextMeta has no prNumber', async () => {
    const job = makeJob('push', { contextMeta: JSON.stringify({ prRepo: 'owner/repo' }) });
    await markDoneFn(job, 0);
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });

  it('does not call startMarkDod when contextMeta is null', async () => {
    const job = makeJob('push', { contextMeta: null });
    await markDoneFn(job, 0);
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });

  it('continues gracefully when startMarkDod throws', async () => {
    startMarkDodMock.mockRejectedValue(new Error('dod failed'));
    const job = makeJob('push', { contextMeta: JSON.stringify({ prNumber: 55, prRepo: 'owner/repo' }) });
    await expect(markDoneFn(job, 0)).resolves.not.toThrow();
  });
});
