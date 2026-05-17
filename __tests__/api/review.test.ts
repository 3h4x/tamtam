import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/projects/by-project/{projectName}/review', () => {
  let POST: typeof import('@/app/api/projects/by-project/[projectName]/review/route').POST;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    startProjectReviewMock = vi.fn();
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: startProjectReviewMock,
    }));
    const mod = await import('@/app/api/projects/by-project/[projectName]/review/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  function req(name = 'proj1', headers?: HeadersInit) {
    return new NextRequest(`http://localhost/api/projects/by-project/${name}/review`, {
      method: 'POST',
      headers,
    });
  }

  it('returns 404 when project not found', async () => {
    startProjectReviewMock.mockResolvedValue({ ok: false, status: 404, detail: 'project not found' });

    const res = await POST(req('unknown'), { params: Promise.resolve({ projectName: 'unknown' }) });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ detail: 'project not found' });
  });

  it('returns 400 when no uncommitted changes', async () => {
    startProjectReviewMock.mockResolvedValue({ ok: false, status: 400, detail: 'No uncommitted changes to review' });

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ detail: 'No uncommitted changes to review' });
  });

  it('returns 409 when review already in progress', async () => {
    startProjectReviewMock.mockResolvedValue({ ok: false, status: 409, detail: 'Review already in progress for proj1' });

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ detail: 'Review already in progress for proj1' });
  });

  it('starts a review job and returns job info', async () => {
    startProjectReviewMock.mockResolvedValue({
      ok: true,
      jobId: 'review-job-id',
      pid: 12345,
      logPath: '/tmp/tamtam-logs/review-job-id.log',
    });

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'started',
      job_id: 'review-job-id',
      pid: 12345,
      log_path: '/tmp/tamtam-logs/review-job-id.log',
    });
  });

  it('passes projectName through to startProjectReview', async () => {
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'review-job-id', pid: 12345, logPath: '/tmp/review.log' });

    await POST(req('my-proj'), { params: Promise.resolve({ projectName: 'my-proj' }) });

    expect(startProjectReviewMock).toHaveBeenCalledWith('my-proj', { preferredProvider: null });
  });

  it('passes a valid preferred provider header through', async () => {
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'review-job-id', pid: 12345, logPath: '/tmp/review.log' });

    await POST(req('proj1', { 'x-tamtam-provider-preferred': 'codex' }), {
      params: Promise.resolve({ projectName: 'proj1' }),
    });

    expect(startProjectReviewMock).toHaveBeenCalledWith('proj1', { preferredProvider: 'codex' });
  });

  it('drops an invalid preferred provider header', async () => {
    startProjectReviewMock.mockResolvedValue({ ok: true, jobId: 'review-job-id', pid: 12345, logPath: '/tmp/review.log' });

    await POST(req('proj1', { 'x-tamtam-provider-preferred': 'not-a-provider' }), {
      params: Promise.resolve({ projectName: 'proj1' }),
    });

    expect(startProjectReviewMock).toHaveBeenCalledWith('proj1', { preferredProvider: null });
  });

  it('returns 409 with blocking_job_id when pipeline is locked', async () => {
    startProjectReviewMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Pipeline already running for proj1',
      blockingJobId: 'blocker-job-99',
    });

    const res = await POST(req(), { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      detail: 'Pipeline already running for proj1',
      blocking_job_id: 'blocker-job-99',
    });
  });
});
