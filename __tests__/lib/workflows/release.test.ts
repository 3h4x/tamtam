import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const startReleaseMock = vi.fn();
const workflowStartMock = vi.fn();
const getJobMock = vi.fn();
const updateJobMock = vi.fn();

vi.mock('@/lib/pipeline/start-release', () => ({
  startRelease: (...args: unknown[]) => startReleaseMock(...args),
}));

vi.mock('workflow/api', () => ({
  start: (...args: unknown[]) => workflowStartMock(...args),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: (...args: unknown[]) => getJobMock(...args),
  updateJob: (...args: unknown[]) => updateJobMock(...args),
}));

import { releaseWorkflow } from '@/lib/workflows/release';

describe('releaseWorkflow', () => {
  beforeEach(() => {
    startReleaseMock.mockReset();
    workflowStartMock.mockReset().mockResolvedValue({ runId: 'wrun_child_1' });
    getJobMock.mockReset();
    updateJobMock.mockReset();
  });

  it('delegates to startRelease with the same args', async () => {
    startReleaseMock.mockResolvedValue({
      ok: true,
      step: 'test',
      jobId: 'job-test-1',
      releaseJobId: 'release-1',
      message: 'Running tests',
    });
    getJobMock.mockReturnValue({ id: 'release-1', kind: 'release', contextMeta: null });
    const r = await releaseWorkflow('proj-1', { queueIfBlocked: true });
    expect(startReleaseMock).toHaveBeenCalledWith('proj-1', { queueIfBlocked: true });
    expect(r).toMatchObject({ ok: true, step: 'test', jobId: 'job-test-1', releaseJobId: 'release-1' });
  });

  it('propagates a non-ok result without modification', async () => {
    startReleaseMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Pipeline is running',
      blockingJobId: 'block-1',
    });
    const r = await releaseWorkflow('proj-1');
    expect(r).toEqual({
      ok: false,
      status: 409,
      detail: 'Pipeline is running',
      blockingJobId: 'block-1',
    });
    expect(workflowStartMock).not.toHaveBeenCalled();
  });

  it('defaults options to {} when not passed', async () => {
    startReleaseMock.mockResolvedValue({ ok: true, step: 'review', message: 'Running review' });
    await releaseWorkflow('proj-1');
    expect(startReleaseMock).toHaveBeenCalledWith('proj-1', {});
  });

  it('does not dispatch the orchestrator when the result is queued (no jobId)', async () => {
    startReleaseMock.mockResolvedValue({ ok: true, status: 'queued', message: 'queued for retry' });
    await releaseWorkflow('proj-1');
    expect(workflowStartMock).not.toHaveBeenCalled();
  });

  it('dispatches the orchestrator workflow on ok and stamps workflowDriven', async () => {
    const releaseMetaJob = { id: 'release-1', kind: 'release' as const, contextMeta: null as string | null };
    getJobMock.mockReturnValue(releaseMetaJob);
    startReleaseMock.mockResolvedValue({
      ok: true,
      step: 'test',
      jobId: 'test-job-1',
      releaseJobId: 'release-1',
      message: 'Running tests',
    });

    await releaseWorkflow('proj-1');

    // contextMeta should hold workflowDriven flag.
    expect(releaseMetaJob.contextMeta).toBe('{"workflowDriven":true}');
    expect(updateJobMock).toHaveBeenCalledWith(releaseMetaJob);

    expect(workflowStartMock).toHaveBeenCalledOnce();
    const [, args] = workflowStartMock.mock.calls[0];
    expect(args).toEqual([
      'test-job-1',
      expect.objectContaining({ projectName: 'proj-1', parentJobId: 'release-1' }),
    ]);
  });

  it('swallows stamping failures so the dispatch still proceeds', async () => {
    getJobMock.mockImplementation(() => { throw new Error('cache miss'); });
    startReleaseMock.mockResolvedValue({
      ok: true,
      step: 'test',
      jobId: 'test-job-1',
      releaseJobId: 'release-1',
      message: 'Running tests',
    });

    const r = await releaseWorkflow('proj-1');

    expect(r.ok).toBe(true);
    expect(workflowStartMock).toHaveBeenCalledOnce();
  });

  it('swallows orchestrator dispatch failures so they do not break the release result', async () => {
    getJobMock.mockReturnValue({ id: 'release-1', kind: 'release', contextMeta: null });
    startReleaseMock.mockResolvedValue({
      ok: true,
      step: 'test',
      jobId: 'job-1',
      releaseJobId: 'release-1',
      message: 'Running tests',
    });
    workflowStartMock.mockRejectedValueOnce(new Error('runtime hiccup'));
    const r = await releaseWorkflow('proj-1');
    expect(r.ok).toBe(true);
    if (r.ok && 'step' in r) expect(r.step).toBe('test');
  });
});

describe('release.ts source guards', () => {
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/release.ts'), 'utf-8');
  it('does NOT contain releaseObservationWorkflow (retired)', () => {
    expect(SRC).not.toMatch(/releaseObservationWorkflow/);
  });
  it('does NOT read TAMTAM_RELEASE_WORKFLOW_DRIVE (env gate retired)', () => {
    expect(SRC).not.toMatch(/TAMTAM_RELEASE_WORKFLOW_DRIVE/);
  });
});
