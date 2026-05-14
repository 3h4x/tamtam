import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';
import { waitForJobCompletion } from '@/lib/workflows/wait-for-job';

const getJobMock = vi.fn<(id: string) => JobData | null>();

vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: (id: string) => getJobMock(id),
}));

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1',
    project: 'p',
    kind: 'test',
    pid: 12345,
    logPath: null,
    prompt: null,
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
    userPrompt: null,
    contextMeta: null,
    parentJobId: null,
    ghIssueNumber: null,
    ghIssueRepo: null,
    ghIssueTitle: null,
    logPruned: false,
    verdict: null,
    costUsd: null,
    model: null,
    releaseId: null,
    abortedAt: null,
    releaseDeadlineAt: null,
    promptBytes: null,
    workSummary: null,
    modifiedFiles: null,
    provider: null,
    ...overrides,
  } as JobData;
}

describe('waitForJobCompletion', () => {
  beforeEach(() => {
    getJobMock.mockReset();
  });

  it('returns immediately when job is already finished on first read', async () => {
    getJobMock.mockReturnValue(makeJob({ finishedAt: 100, exitCode: 0 }));
    const r = await waitForJobCompletion('job-1', { pollIntervalMs: 1 });
    expect(r.finished).toBe(true);
    expect(r.reason).toBe('finished');
    expect(r.job?.exitCode).toBe(0);
    expect(getJobMock).toHaveBeenCalledTimes(1);
  });

  it('returns not_found when job is missing', async () => {
    getJobMock.mockReturnValue(null);
    const r = await waitForJobCompletion('missing', { pollIntervalMs: 1 });
    expect(r.finished).toBe(false);
    expect(r.reason).toBe('not_found');
    expect(r.job).toBeNull();
  });

  it('polls until finishedAt becomes non-null', async () => {
    getJobMock
      .mockReturnValueOnce(makeJob())
      .mockReturnValueOnce(makeJob())
      .mockReturnValueOnce(makeJob({ finishedAt: 200, exitCode: 0 }));
    const r = await waitForJobCompletion('job-1', { pollIntervalMs: 1 });
    expect(r.finished).toBe(true);
    expect(r.reason).toBe('finished');
    expect(getJobMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('resolves with timeout reason when ceiling is hit', async () => {
    getJobMock.mockReturnValue(makeJob());
    const r = await waitForJobCompletion('job-1', { pollIntervalMs: 5, timeoutMs: 20 });
    expect(r.finished).toBe(false);
    expect(r.reason).toBe('timeout');
  });

  it('aborts on AbortSignal', async () => {
    getJobMock.mockReturnValue(makeJob());
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const r = await waitForJobCompletion('job-1', { pollIntervalMs: 50, signal: ac.signal });
    expect(r.finished).toBe(false);
    expect(r.reason).toBe('aborted');
  });

  it('treats job disappearing during polling as not_found', async () => {
    getJobMock
      .mockReturnValueOnce(makeJob())
      .mockReturnValueOnce(null);
    const r = await waitForJobCompletion('job-1', { pollIntervalMs: 1 });
    expect(r.finished).toBe(false);
    expect(r.reason).toBe('not_found');
  });
});
