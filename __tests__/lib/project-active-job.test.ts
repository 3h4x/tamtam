import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1',
    project: 'proj',
    kind: 'run',
    prompt: 'Ship it',
    pid: 99999,
    logPath: '/tmp/job.log',
    startedAt: 1,
    finishedAt: null,
    exitCode: null,
    seen: false,
    verdict: null,
    contextMeta: null,
    userPrompt: null,
    parentJobId: null,
    ghIssueNumber: null,
    ghIssueRepo: null,
    ghIssueTitle: null,
    releaseId: null,
    abortedAt: null,
    ...overrides,
  };
}

describe('findBlockingRunningJob', () => {
  const listJobsMock = vi.fn();
  const probeJobStatusMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    listJobsMock.mockReset();
    probeJobStatusMock.mockReset();

    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
    }));
  });

  it('returns the first unfinished job in the project whose probe still says running', async () => {
    const stale = makeJob({ id: 'stale-1' });
    const running = makeJob({ id: 'running-1', kind: 'fix' });
    listJobsMock.mockReturnValue([
      makeJob({ id: 'other-project', project: 'elsewhere' }),
      makeJob({ id: 'finished-1', finishedAt: 5, exitCode: 0 }),
      stale,
      running,
    ]);
    probeJobStatusMock
      .mockResolvedValueOnce('finished')
      .mockResolvedValueOnce('running');

    const { findBlockingRunningJob } = await import('@/lib/jobs/project-active-job');
    await expect(findBlockingRunningJob('proj')).resolves.toBe(running);
    expect(probeJobStatusMock).toHaveBeenCalledTimes(2);
    expect(probeJobStatusMock).toHaveBeenNthCalledWith(1, stale);
    expect(probeJobStatusMock).toHaveBeenNthCalledWith(2, running);
  });

  it('applies the predicate before probing jobs', async () => {
    const runJob = makeJob({ id: 'run-1', kind: 'run' });
    const reviewJob = makeJob({ id: 'review-1', kind: 'review' });
    listJobsMock.mockReturnValue([runJob, reviewJob]);
    probeJobStatusMock.mockResolvedValue('running');

    const { findBlockingRunningJob } = await import('@/lib/jobs/project-active-job');
    await expect(findBlockingRunningJob('proj', (job) => job.kind === 'review')).resolves.toBe(reviewJob);
    expect(probeJobStatusMock).toHaveBeenCalledTimes(1);
    expect(probeJobStatusMock).toHaveBeenCalledWith(reviewJob);
  });

  it('returns null when every candidate has already stopped', async () => {
    const runJob = makeJob({ id: 'run-1', kind: 'run' });
    const fixJob = makeJob({ id: 'fix-1', kind: 'fix' });
    listJobsMock.mockReturnValue([runJob, fixJob]);
    probeJobStatusMock
      .mockResolvedValueOnce('finished')
      .mockResolvedValueOnce('missing');

    const { findBlockingRunningJob } = await import('@/lib/jobs/project-active-job');
    await expect(findBlockingRunningJob('proj')).resolves.toBeNull();
    expect(probeJobStatusMock).toHaveBeenCalledTimes(2);
  });
});
