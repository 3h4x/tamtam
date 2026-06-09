import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/projects/by-project/[projectName]/push', () => {
  let POST: typeof import('@/app/api/projects/by-project/[projectName]/push/route').POST;
  let launchProjectPushMock: ReturnType<typeof vi.fn>;
  let validateReleaseLinkedPushRetryMock: ReturnType<typeof vi.fn>;
  let validateReleaseLinkedCommitRetryMock: ReturnType<typeof vi.fn>;
  let startProjectCommitMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    launchProjectPushMock = vi.fn().mockReturnValue({ jobId: 'push-job-id' });
    const okValidator = (_projectName: string, parentJobId?: string | null) => ({
      ok: true,
      parentJobId: parentJobId ?? null,
      releaseLinkedRetry: !!parentJobId,
    });
    validateReleaseLinkedPushRetryMock = vi.fn().mockImplementation(okValidator);
    validateReleaseLinkedCommitRetryMock = vi.fn().mockImplementation(okValidator);
    startProjectCommitMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc1234', message: 'committed', jobId: 'commit-job-id' });
    vi.doMock('@/lib/pipeline/start-push', () => ({
      launchProjectPush: launchProjectPushMock,
      validateReleaseLinkedPushRetry: validateReleaseLinkedPushRetryMock,
      validateReleaseLinkedCommitRetry: validateReleaseLinkedCommitRetryMock,
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
    expect(validateReleaseLinkedPushRetryMock).toHaveBeenCalledWith('my-repo', null);
    expect(launchProjectPushMock).toHaveBeenCalledWith('my-repo', { parentJobId: null });
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });

  it('commit:true in body routes to startProjectCommit via the looser commit-retry validator', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit: true }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(validateReleaseLinkedCommitRetryMock).toHaveBeenCalledWith('my-repo', null);
    expect(validateReleaseLinkedPushRetryMock).not.toHaveBeenCalled();
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
    expect(validateReleaseLinkedPushRetryMock).toHaveBeenCalledWith('my-repo', 'release-123');
    expect(launchProjectPushMock).toHaveBeenCalledWith('my-repo', { parentJobId: 'release-123' });
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });

  it('forwards release_id to commit mode through the looser commit-retry validator (History "Retry commit")', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit: true, release_id: 'release-456' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(validateReleaseLinkedCommitRetryMock).toHaveBeenCalledWith('my-repo', 'release-456');
    expect(validateReleaseLinkedPushRetryMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).toHaveBeenCalledWith('my-repo', { parentJobId: 'release-456' });
    expect(launchProjectPushMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid release-linked retry before launchProjectPush runs', async () => {
    validateReleaseLinkedPushRetryMock.mockReturnValue({
      ok: false,
      status: 409,
      detail: 'Retry push is only allowed when the latest step on the release is a failed push for my-repo',
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
    validateReleaseLinkedCommitRetryMock.mockReturnValue({
      ok: false,
      status: 409,
      detail: 'Retry commit is only allowed when the latest step on the release is a failed commit for my-repo',
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

  it('the History "Retry commit" round-trip: { commit: true, release_id } returns 200 even when the release is finished', async () => {
    // Realistic case: failed commit on a finished release.
    // The looser commit-retry validator accepts this and the route launches a
    // standalone commit job linked to the same release_id for trace continuity.
    validateReleaseLinkedCommitRetryMock.mockReturnValue({
      ok: true,
      parentJobId: 'release-commit-failed',
      releaseLinkedRetry: true,
    });
    startProjectCommitMock.mockResolvedValue({ ok: true, jobId: 'commit-retry-1' });
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit: true, release_id: 'release-commit-failed' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBe('commit-retry-1');
    expect(startProjectCommitMock).toHaveBeenCalledWith('my-repo', { parentJobId: 'release-commit-failed' });
  });

  it('the History "Retry push" round-trip: { release_id } returns 200 without commit mode for a finished release', async () => {
    validateReleaseLinkedPushRetryMock.mockReturnValue({
      ok: true,
      parentJobId: 'release-push-failed',
      releaseLinkedRetry: true,
    });
    launchProjectPushMock.mockReturnValue({ jobId: 'push-retry-1' });
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ release_id: 'release-push-failed' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBe('push-retry-1');
    expect(validateReleaseLinkedPushRetryMock).toHaveBeenCalledWith('my-repo', 'release-push-failed');
    expect(validateReleaseLinkedCommitRetryMock).not.toHaveBeenCalled();
    expect(startProjectCommitMock).not.toHaveBeenCalled();
    expect(launchProjectPushMock).toHaveBeenCalledWith('my-repo', { parentJobId: 'release-push-failed' });
  });

  it('treats invalid JSON body as default push-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(validateReleaseLinkedPushRetryMock).toHaveBeenCalledWith('my-repo', null);
    expect(launchProjectPushMock).toHaveBeenCalledWith('my-repo', { parentJobId: null });
    expect(startProjectCommitMock).not.toHaveBeenCalled();
  });
});
