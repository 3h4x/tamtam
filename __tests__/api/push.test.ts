import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/projects/by-project/[projectName]/push', () => {
  let POST: any;
  let launchProjectPushMock: ReturnType<typeof vi.fn>;
  let validateReleaseLinkedRetryMock: ReturnType<typeof vi.fn>;
  let startProjectCommitMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    launchProjectPushMock = vi.fn().mockReturnValue({ jobId: 'push-job-id' });
    validateReleaseLinkedRetryMock = vi.fn().mockImplementation((_projectName: string, parentJobId?: string | null) => ({
      ok: true,
      parentJobId: parentJobId ?? null,
      releaseLinkedRetry: !!parentJobId,
    }));
    startProjectCommitMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc1234', message: 'committed', jobId: 'commit-job-id' });
    vi.doMock('@/lib/pipeline/start-push', () => ({
      launchProjectPush: launchProjectPushMock,
      validateReleaseLinkedRetry: validateReleaseLinkedRetryMock,
    }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: startProjectCommitMock }));
    const mod = await import('@/app/api/projects/by-project/[projectName]/push/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when launchProjectPush returns an error', async () => {
    launchProjectPushMock.mockReturnValue({ error: 'project not found' });
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('project not found');
  });

  it('forwards explicit status from launchProjectPush error (e.g. 409 lock held)', async () => {
    launchProjectPushMock.mockReturnValue({ error: 'Pipeline is running for myproj — wait for it to finish before pushing manually', status: 409 });
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('Pipeline is running');
  });

  it('returns started status with job_id when launch succeeds', async () => {
    launchProjectPushMock.mockReturnValue({ jobId: 'abc-123' });
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBe('abc-123');
  });

  it('default (no body) routes to push-only via launchProjectPush', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', { method: 'POST' });
    await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(validateReleaseLinkedRetryMock).toHaveBeenCalledWith('my-repo', null);
    expect(launchProjectPushMock).toHaveBeenCalledWith('my-repo', { parentJobId: null });
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });

  it('commit:true in body routes to startProjectCommit (Push to PR flow)', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit: true }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(validateReleaseLinkedRetryMock).toHaveBeenCalledWith('my-repo', null);
    expect(startProjectCommitMock).toHaveBeenCalledWith('my-repo', { parentJobId: null });
    expect(launchProjectPushMock).not.toHaveBeenCalled();
    const data = await res.json();
    expect(data.job_id).toBe('commit-job-id');
  });

  it('forwards release_id to push-only retries so they stay linked to the release chain', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ release_id: 'release-123' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(validateReleaseLinkedRetryMock).toHaveBeenCalledWith('my-repo', 'release-123');
    expect(launchProjectPushMock).toHaveBeenCalledWith('my-repo', { parentJobId: 'release-123' });
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });

  it('forwards release_id to commit mode so the commit inherits the release parent', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit: true, release_id: 'release-456' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(validateReleaseLinkedRetryMock).toHaveBeenCalledWith('my-repo', 'release-456');
    expect(startProjectCommitMock).toHaveBeenCalledWith('my-repo', { parentJobId: 'release-456' });
    expect(launchProjectPushMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid release-linked retry before launchProjectPush runs', async () => {
    validateReleaseLinkedRetryMock.mockReturnValue({
      ok: false,
      status: 409,
      detail: 'Release-linked push retry is only allowed for the active release on my-repo',
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ release_id: 'stale-release' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(res.status).toBe(409);
    expect(launchProjectPushMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid release-linked commit retry before startProjectCommit runs', async () => {
    validateReleaseLinkedRetryMock.mockReturnValue({
      ok: false,
      status: 409,
      detail: 'Release-linked push retry is only allowed when the latest step is a failed push for my-repo',
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit: true, release_id: 'release-789' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(res.status).toBe(409);
    expect(startProjectCommitMock).not.toHaveBeenCalled();
    expect(launchProjectPushMock).not.toHaveBeenCalled();
  });

  it('returns commit failure detail when startProjectCommit returns ok:false', async () => {
    startProjectCommitMock.mockResolvedValue({ ok: false, status: 409, detail: 'Pipeline is running for my-repo' });
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit: true }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('Pipeline is running');
  });

  it('treats invalid JSON body as default push-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(validateReleaseLinkedRetryMock).toHaveBeenCalledWith('my-repo', null);
    expect(launchProjectPushMock).toHaveBeenCalledWith('my-repo', { parentJobId: null });
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });
});
