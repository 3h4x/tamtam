import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/projects/by-project/{projectName}/release', () => {
  let POST: typeof import('@/app/api/projects/by-project/[projectName]/release/route').POST;
  let startReleaseMock: ReturnType<typeof vi.fn>;

  // These tests assert the route's response-shaping on top of startRelease.
  // The workflow body runs inline (no real Vercel Workflow runtime in
  // tests); `workflow/api`'s `start` is mocked to invoke releaseWorkflow
  // directly and stub child workflow dispatches. DRIVE=0 keeps the workflow
  // on the simpler observation path (no orchestrator meta-job lookup).
  const savedDriveEnv = process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE;

  beforeEach(async () => {
    process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE = '0';
    vi.resetModules();
    startReleaseMock = vi.fn();
    vi.doMock('@/lib/pipeline/start-release', () => ({ startRelease: startReleaseMock }));
    vi.doMock('workflow/api', () => ({
      start: async (fn: any, args: any[]) => {
        if (fn?.name === 'releaseWorkflow') {
          return { returnValue: Promise.resolve(await fn(...args)) };
        }
        return { returnValue: Promise.resolve({}) };
      },
    }));
    const mod = await import('@/app/api/projects/by-project/[projectName]/release/route');
    POST = mod.POST;
  });

  afterEach(() => {
    if (savedDriveEnv === undefined) delete process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE;
    else process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE = savedDriveEnv;
    vi.resetModules();
  });

  function req(name = 'proj1', body?: unknown) {
    return new NextRequest(`http://localhost/api/projects/by-project/${name}/release`, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it('returns 200 with step=test when tests start', async () => {
    startReleaseMock.mockResolvedValue({ ok: true, step: 'test', jobId: 't1', message: 'Running tests (pnpm test)' });
    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ status: 'started', step: 'test', job_id: 't1', message: 'Running tests (pnpm test)' });
  });

  it('returns 200 with step=review when review starts', async () => {
    startReleaseMock.mockResolvedValue({ ok: true, step: 'review', jobId: 'r1', message: 'Running review' });
    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.step).toBe('review');
    expect(data.job_id).toBe('r1');
  });

  it('returns 200 with step=push when pushing only', async () => {
    startReleaseMock.mockResolvedValue({ ok: true, step: 'push', message: 'pushed' });
    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.step).toBe('push');
    expect(data.job_id).toBeUndefined();
  });

  it('returns 404 when project not found', async () => {
    startReleaseMock.mockResolvedValue({ ok: false, status: 404, detail: 'project not found' });
    const res = await POST(req('missing'), { params: Promise.resolve({ projectName: 'missing' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('project not found');
  });

  it('returns 400 when nothing to release', async () => {
    startReleaseMock.mockResolvedValue({ ok: false, status: 400, detail: 'Nothing to release — no changes and no unpushed commits' });
    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('Nothing to release');
  });

  it('propagates conflict status from underlying starter', async () => {
    startReleaseMock.mockResolvedValue({ ok: false, status: 409, detail: 'Tests already running for proj1' });
    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
  });

  it('passes projectName through to startRelease', async () => {
    startReleaseMock.mockResolvedValue({ ok: true, step: 'push', message: 'No changes to push' });
    await POST(req('my-proj'), { params: Promise.resolve({ projectName: 'my-proj' }) });
    expect(startReleaseMock).toHaveBeenCalledWith('my-proj', { queueIfBlocked: false, sourceJobId: undefined, operatorInitiated: true });
  });

  it('passes source_job_id through to startRelease', async () => {
    startReleaseMock.mockResolvedValue({ ok: true, step: 'review', jobId: 'r1', message: 'Running review' });
    await POST(req('proj1', { source_job_id: 'job-123' }), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(startReleaseMock).toHaveBeenCalledWith('proj1', { queueIfBlocked: false, sourceJobId: 'job-123', operatorInitiated: true });
  });

  it('queues instead of failing when queue_if_blocked is true', async () => {
    startReleaseMock.mockResolvedValue({
      ok: true,
      status: 'queued',
      message: 'Release queued for proj1',
      blockingJobId: 'blocker-job-42',
    });
    const res = await POST(req('proj1', { queue_if_blocked: true }), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(startReleaseMock).toHaveBeenCalledWith('proj1', { queueIfBlocked: true, sourceJobId: undefined, operatorInitiated: true });
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data).toEqual({
      status: 'queued',
      message: 'Release queued for proj1',
      blocking_job_id: 'blocker-job-42',
    });
  });

  it('includes blocking_job_id in 409 response when pipeline is locked', async () => {
    startReleaseMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Pipeline already running for proj1',
      blockingJobId: 'blocker-job-42',
    });
    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('Pipeline already running');
    expect(data.blocking_job_id).toBe('blocker-job-42');
  });

  it('does not include blocking_job_id when error has no blockingJobId', async () => {
    startReleaseMock.mockResolvedValue({
      ok: false,
      status: 400,
      detail: 'Nothing to release',
    });
    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.blocking_job_id).toBeUndefined();
  });
});
