import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/job-storage';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1',
    project: 'proj1',
    kind: 'run',
    prompt: null,
    pid: 1234,
    logPath: null,
    startedAt: 1000,
    finishedAt: 2000,
    exitCode: 0,
    seen: false,
    ...overrides,
  };
}

describe('POST /api/jobs/[jobId]/seen', () => {
  let POST: any;
  let markSeenMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    markSeenMock = vi.fn().mockReturnValue(true);
    vi.doMock('@/lib/job-storage', () => ({ markSeen: markSeenMock }));
    const mod = await import('@/app/api/jobs/[jobId]/seen/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns ok when job exists', async () => {
    const req = new NextRequest('http://localhost/api/jobs/job-1/seen', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('calls markSeen with the jobId from params', async () => {
    const req = new NextRequest('http://localhost/api/jobs/job-abc/seen', { method: 'POST' });
    await POST(req, { params: Promise.resolve({ jobId: 'job-abc' }) });
    expect(markSeenMock).toHaveBeenCalledWith('job-abc');
  });

  it('returns 404 when job not found', async () => {
    markSeenMock.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/jobs/nonexistent/seen', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('nonexistent');
  });
});

describe('GET /api/jobs/notifications', () => {
  let GET: any;
  let unseenFinishedMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let jobToDictMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    unseenFinishedMock = vi.fn().mockReturnValue([]);
    listJobsMock = vi.fn().mockReturnValue([]);
    jobToDictMock = vi.fn().mockImplementation((j: JobData) => ({ id: j.id, project: j.project }));
    vi.doMock('@/lib/job-storage', () => ({
      unseenFinished: unseenFinishedMock,
      listJobs: listJobsMock,
      jobToDict: jobToDictMock,
    }));
    const mod = await import('@/app/api/jobs/notifications/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns empty counts when no jobs', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(0);
    expect(data.jobs).toEqual([]);
    expect(data.runningCount).toBe(0);
    expect(data.runningJobs).toEqual([]);
  });

  it('returns unseen finished jobs in count and jobs', async () => {
    const job = makeJob({ id: 'j1', seen: false });
    unseenFinishedMock.mockReturnValue([job]);
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].id).toBe('j1');
  });

  it('returns running jobs separately', async () => {
    const running = makeJob({ id: 'r1', finishedAt: null, exitCode: null });
    listJobsMock.mockReturnValue([running]);
    const res = await GET();
    const data = await res.json();
    expect(data.runningCount).toBe(1);
    expect(data.runningJobs[0].id).toBe('r1');
  });

  it('excludes finished jobs from runningJobs', async () => {
    const finished = makeJob({ id: 'f1', finishedAt: 2000 });
    listJobsMock.mockReturnValue([finished]);
    const res = await GET();
    const data = await res.json();
    expect(data.runningCount).toBe(0);
    expect(data.runningJobs).toEqual([]);
  });

  it('counts unseen and running independently', async () => {
    const unseen = makeJob({ id: 'u1', seen: false });
    const running = makeJob({ id: 'r1', finishedAt: null, exitCode: null });
    unseenFinishedMock.mockReturnValue([unseen]);
    listJobsMock.mockReturnValue([unseen, running]);
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.runningCount).toBe(1);
  });
});

describe('POST /api/jobs/notifications/mark-seen', () => {
  let POST: any;
  let unseenFinishedMock: ReturnType<typeof vi.fn>;
  let markSeenMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    unseenFinishedMock = vi.fn().mockReturnValue([]);
    markSeenMock = vi.fn().mockReturnValue(true);
    vi.doMock('@/lib/job-storage', () => ({
      unseenFinished: unseenFinishedMock,
      markSeen: markSeenMock,
    }));
    const mod = await import('@/app/api/jobs/notifications/mark-seen/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns ok', async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('calls markSeen for each unseen job', async () => {
    const jobs = [makeJob({ id: 'j1' }), makeJob({ id: 'j2' })];
    unseenFinishedMock.mockReturnValue(jobs);
    await POST();
    expect(markSeenMock).toHaveBeenCalledTimes(2);
    expect(markSeenMock).toHaveBeenCalledWith('j1');
    expect(markSeenMock).toHaveBeenCalledWith('j2');
  });

  it('does not call markSeen when no unseen jobs', async () => {
    unseenFinishedMock.mockReturnValue([]);
    await POST();
    expect(markSeenMock).not.toHaveBeenCalled();
  });
});
