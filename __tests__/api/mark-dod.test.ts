import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('POST /api/projects/by-project/{projectName}/mark-dod', () => {
  let POST: any;
  let startMarkDodMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    startMarkDodMock = vi.fn();
    vi.doMock('@/lib/start-mark-dod', () => ({ startMarkDod: startMarkDodMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/mark-dod/route');
    POST = mod.POST;
  });

  afterEach(() => { vi.resetModules(); });

  function params(projectName: string) {
    return { params: Promise.resolve({ projectName }) };
  }

  it('returns 200 with result on success', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: true, jobId: 'job-1', issueNumber: 42, verified: 2, total: 3, changed: true,
    });
    const res = await POST(new Request('http://localhost'), params('myproj'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.issueNumber).toBe(42);
    expect(data.verified).toBe(2);
    expect(data.changed).toBe(true);
  });

  it('returns the error status and detail when startMarkDod returns ok:false', async () => {
    startMarkDodMock.mockResolvedValue({ ok: false, status: 404, detail: 'project not found' });
    const res = await POST(new Request('http://localhost'), params('unknown'));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('project not found');
  });

  it('returns 400 when no issue context', async () => {
    startMarkDodMock.mockResolvedValue({ ok: false, status: 400, detail: 'no issue context on latest run' });
    const res = await POST(new Request('http://localhost'), params('myproj'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('no issue context');
  });

  it('returns 500 with detail when startMarkDod throws', async () => {
    startMarkDodMock.mockRejectedValue(new Error('unexpected db error'));
    const res = await POST(new Request('http://localhost'), params('myproj'));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('unexpected db error');
  });

  it('passes projectName from route params to startMarkDod (no body → no override)', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: true, jobId: 'j', issueNumber: 1, verified: 0, total: 0, changed: false,
    });
    await POST(new Request('http://localhost'), params('specific-project'));
    expect(startMarkDodMock).toHaveBeenCalledWith('specific-project', undefined);
  });

  it('forwards explicit issue context from request body as override', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: true, jobId: 'j', issueNumber: 8, verified: 1, total: 5, changed: true,
    });
    const req = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue_number: 8, repo: 'owner/repo' }),
    });
    await POST(req, params('myproj'));
    expect(startMarkDodMock).toHaveBeenCalledWith('myproj', {
      issueNumber: 8,
      prNumber: undefined,
      repo: 'owner/repo',
    });
  });

  it('forwards explicit PR context from request body as override', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: true, jobId: 'j', issueNumber: 8, verified: 0, total: 5, changed: false,
    });
    const req = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr_number: 39, repo: 'owner/repo' }),
    });
    await POST(req, params('myproj'));
    expect(startMarkDodMock).toHaveBeenCalledWith('myproj', {
      issueNumber: undefined,
      prNumber: 39,
      repo: 'owner/repo',
    });
  });

  it('ignores body without repo (treats as no override)', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: true, jobId: 'j', issueNumber: 1, verified: 0, total: 0, changed: false,
    });
    const req = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue_number: 8 }),
    });
    await POST(req, params('myproj'));
    expect(startMarkDodMock).toHaveBeenCalledWith('myproj', undefined);
  });

  it('ignores invalid JSON body (treats as no override)', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: true, jobId: 'j', issueNumber: 1, verified: 0, total: 0, changed: false,
    });
    const req = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    await POST(req, params('myproj'));
    expect(startMarkDodMock).toHaveBeenCalledWith('myproj', undefined);
  });

  it('returns 200 with changed:false when nothing was updated', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: true, jobId: 'j', issueNumber: 7, verified: 0, total: 5, changed: false,
    });
    const res = await POST(new Request('http://localhost'), params('myproj'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.changed).toBe(false);
    expect(data.total).toBe(5);
  });
});
