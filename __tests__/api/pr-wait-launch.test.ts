import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/projects/by-project/{projectName}/pr-wait', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ projectName: string }> }) => Promise<Response>;
  let launchPrWaitMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let resolvePrTargetMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    launchPrWaitMock = vi.fn().mockReturnValue({ jobId: 'pr-wait-job-1' });
    resolveProjectPathMock = vi.fn().mockReturnValue('/repo/proj');
    resolvePrTargetMock = vi.fn().mockResolvedValue({
      prRepo: 'owner/repo',
      prUrl: 'https://github.com/owner/repo/pull/42',
    });
    vi.doMock('@/lib/pipeline/start-pr-wait', () => ({
      launchPrWait: launchPrWaitMock,
      resolvePrTarget: resolvePrTargetMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/pr-wait/route');
    POST = mod.POST;
  });

  it('starts pr-wait with explicit PR identity', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/projects/by-project/p/pr-wait', {
        method: 'POST',
        body: JSON.stringify({ prNumber: 42, prRepo: 'owner/repo', prUrl: 'https://x/pull/42' }),
      }),
      { params: Promise.resolve({ projectName: 'p' }) },
    );
    expect(res.status).toBe(200);
    expect(launchPrWaitMock).toHaveBeenCalledWith('p', 42, 'owner/repo', 'https://x/pull/42');
    expect(resolvePrTargetMock).not.toHaveBeenCalled();
  });

  it('resolves PR identity via gh when only prNumber is given', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/projects/by-project/p/pr-wait', {
        method: 'POST',
        body: JSON.stringify({ prNumber: 42 }),
      }),
      { params: Promise.resolve({ projectName: 'p' }) },
    );
    expect(res.status).toBe(200);
    expect(resolvePrTargetMock).toHaveBeenCalledWith('/repo/proj', 42);
    expect(launchPrWaitMock).toHaveBeenCalledWith('p', 42, 'owner/repo', 'https://github.com/owner/repo/pull/42');
    const body = await res.json();
    expect(body.jobId).toBe('pr-wait-job-1');
  });

  it('rejects when prNumber is missing', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/projects/by-project/p/pr-wait', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ projectName: 'p' }) },
    );
    expect(res.status).toBe(400);
    expect(launchPrWaitMock).not.toHaveBeenCalled();
  });

  it('returns 502 when gh pr view fails', async () => {
    resolvePrTargetMock.mockResolvedValue({ error: 'gh pr view failed: gh: not authenticated' });
    const res = await POST(
      new NextRequest('http://localhost/api/projects/by-project/p/pr-wait', {
        method: 'POST',
        body: JSON.stringify({ prNumber: 42 }),
      }),
      { params: Promise.resolve({ projectName: 'p' }) },
    );
    expect(res.status).toBe(502);
    expect(launchPrWaitMock).not.toHaveBeenCalled();
  });

  it('returns 500 when launchPrWait errors', async () => {
    launchPrWaitMock.mockReturnValue({ error: 'project not found' });
    const res = await POST(
      new NextRequest('http://localhost/api/projects/by-project/p/pr-wait', {
        method: 'POST',
        body: JSON.stringify({ prNumber: 42, prRepo: 'owner/repo', prUrl: 'https://x/pull/42' }),
      }),
      { params: Promise.resolve({ projectName: 'p' }) },
    );
    expect(res.status).toBe(500);
  });

  it('returns 409 when jobs are paused', async () => {
    launchPrWaitMock.mockReturnValue({ error: 'jobs paused' });
    const res = await POST(
      new NextRequest('http://localhost/api/projects/by-project/p/pr-wait', {
        method: 'POST',
        body: JSON.stringify({ prNumber: 42, prRepo: 'owner/repo', prUrl: 'https://x/pull/42' }),
      }),
      { params: Promise.resolve({ projectName: 'p' }) },
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'jobs paused' });
  });
});
