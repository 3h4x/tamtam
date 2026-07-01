import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

function makeRequest(body: unknown, raw = false): NextRequest {
  return new NextRequest('http://localhost/api/projects/by-project/proj1/address-pr-comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

const params = Promise.resolve({ projectName: 'proj1' });

describe('POST /api/projects/by-project/{projectName}/address-pr-comments', () => {
  let POST: typeof import('@/app/api/projects/by-project/[projectName]/address-pr-comments/route').POST;
  let startMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    startMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'job-1', pid: 4242, logPath: '/tmp/job-1.log' });
    vi.doMock('@/lib/pipeline/start-pr-comment-fix', () => ({ startPrCommentFix: startMock }));
    ({ POST } = await import('@/app/api/projects/by-project/[projectName]/address-pr-comments/route'));
  });

  it('returns the job id on success and forwards the PR number', async () => {
    const res = await POST(makeRequest({ pr: 7 }), { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ status: 'started', job_id: 'job-1', pid: 4242, log_path: '/tmp/job-1.log' });
    expect(startMock).toHaveBeenCalledWith('proj1', 7);
  });

  it('rejects invalid JSON', async () => {
    const res = await POST(makeRequest('{not json', true), { params });
    expect(res.status).toBe(400);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('rejects a missing or non-integer pr number', async () => {
    for (const bad of [{}, { pr: 'x' }, { pr: 1.5 }, { pr: 0 }, { pr: -3 }]) {
      const res = await POST(makeRequest(bad), { params });
      expect(res.status).toBe(400);
    }
    expect(startMock).not.toHaveBeenCalled();
  });

  it('propagates the helper error status and detail', async () => {
    startMock.mockResolvedValue({ ok: false, status: 429, detail: 'Fix-loop cap reached', blockingJobId: 'j9' });
    const res = await POST(makeRequest({ pr: 7 }), { params });
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data).toMatchObject({ detail: 'Fix-loop cap reached', blockingJobId: 'j9' });
  });

  it('returns 500 when the helper throws', async () => {
    startMock.mockRejectedValue(new Error('boom'));
    const res = await POST(makeRequest({ pr: 7 }), { params });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toBe('boom');
  });
});
