import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/projects/by-project/{projectName}/release/abort', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ projectName: string }> }) => Promise<Response>;
  let abortActiveReleaseMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    abortActiveReleaseMock = vi.fn().mockResolvedValue({
      status: 'aborted',
      release_id: 'release-1',
      killed_job_id: null,
      httpStatus: 200,
    });
    vi.doMock('@/lib/pipeline/release-abort', () => ({
      abortActiveRelease: abortActiveReleaseMock,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/release/abort/route');
    POST = mod.POST;
  });

  it('delegates user aborts to the shared release abort helper', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/projects/by-project/proj1/release/abort', { method: 'POST' }),
      { params: Promise.resolve({ projectName: 'proj1' }) },
    );

    expect(res.status).toBe(200);
    expect(abortActiveReleaseMock).toHaveBeenCalledWith('proj1', { reason: 'user' });
    expect(await res.json()).toEqual({
      status: 'aborted',
      release_id: 'release-1',
      killed_job_id: null,
    });
  });

  it('uses the helper status code for pending aborts', async () => {
    abortActiveReleaseMock.mockResolvedValue({
      status: 'abort_pending',
      detail: 'Timed out waiting for push to stop cleanly',
      release_id: 'release-1',
      killed_job_id: null,
      httpStatus: 409,
    });

    const res = await POST(
      new NextRequest('http://localhost/api/projects/by-project/proj1/release/abort', { method: 'POST' }),
      { params: Promise.resolve({ projectName: 'proj1' }) },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      status: 'abort_pending',
      detail: 'Timed out waiting for push to stop cleanly',
      release_id: 'release-1',
      killed_job_id: null,
    });
  });
});
