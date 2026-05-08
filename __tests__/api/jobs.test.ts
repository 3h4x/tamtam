import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobData } from '@/lib/jobs/job-storage';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1',
    project: 'proj1',
    kind: 'run',
    prompt: null,
    pid: 1234,
    logPath: null,
    startedAt: 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  };
}

describe('GET /api/jobs', () => {
  let GET: any;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let jobToDictMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    jobToDictMock = vi.fn().mockImplementation((j: JobData) => ({
      id: j.id,
      project: j.project,
      kind: j.kind,
      status: j.finishedAt ? 'done' : 'running',
    }));

    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
      jobToDict: jobToDictMock,
    }));

    const mod = await import('@/app/api/jobs/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns empty jobs list', async () => {
    const req = new NextRequest('http://localhost/api/jobs');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobs).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('returns all jobs', async () => {
    const job1 = makeJob({ id: 'job-1', project: 'proj1' });
    const job2 = makeJob({ id: 'job-2', project: 'proj2' });
    listJobsMock.mockReturnValue([job1, job2]);

    const req = new NextRequest('http://localhost/api/jobs');
    const res = await GET(req);
    const data = await res.json();
    expect(data.jobs).toHaveLength(2);
    expect(data.total).toBe(2);
    expect(data.jobs[0].id).toBe('job-1');
    expect(data.jobs[1].id).toBe('job-2');
  });

  it('filters by project query param', async () => {
    const job1 = makeJob({ id: 'job-1', project: 'proj1' });
    const job2 = makeJob({ id: 'job-2', project: 'proj2' });
    listJobsMock.mockReturnValue([job1, job2]);

    const req = new NextRequest('http://localhost/api/jobs?project=proj1');
    const res = await GET(req);
    const data = await res.json();
    expect(data.jobs).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.jobs[0].id).toBe('job-1');
  });

  it('calls probeJobStatus for each job', async () => {
    const job1 = makeJob({ id: 'job-1' });
    const job2 = makeJob({ id: 'job-2' });
    listJobsMock.mockReturnValue([job1, job2]);

    const req = new NextRequest('http://localhost/api/jobs');
    await GET(req);
    expect(probeJobStatusMock).toHaveBeenCalledTimes(2);
  });

  it('returns empty list when project filter matches nothing', async () => {
    const job1 = makeJob({ id: 'job-1', project: 'proj1' });
    listJobsMock.mockReturnValue([job1]);

    const req = new NextRequest('http://localhost/api/jobs?project=nonexistent');
    const res = await GET(req);
    const data = await res.json();
    expect(data.jobs).toEqual([]);
  });

  it('sorts jobs newest-first by startedAt', async () => {
    const old = makeJob({ id: 'old', startedAt: 100 });
    const mid = makeJob({ id: 'mid', startedAt: 500 });
    const newest = makeJob({ id: 'new', startedAt: 900 });
    listJobsMock.mockReturnValue([old, newest, mid]);

    const req = new NextRequest('http://localhost/api/jobs');
    const res = await GET(req);
    const data = await res.json();
    expect(data.jobs.map((j: any) => j.id)).toEqual(['new', 'mid', 'old']);
  });

  it('respects explicit limit param', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ id: `job-${i}`, startedAt: i })
    );
    listJobsMock.mockReturnValue(jobs);

    const req = new NextRequest('http://localhost/api/jobs?limit=3');
    const res = await GET(req);
    const data = await res.json();
    expect(data.jobs).toHaveLength(3);
    expect(data.total).toBe(5);
  });

  it('limit applies to newest jobs — oldest are dropped', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ id: `job-${i}`, startedAt: i })
    );
    listJobsMock.mockReturnValue(jobs);

    const req = new NextRequest('http://localhost/api/jobs?limit=2');
    const res = await GET(req);
    const data = await res.json();
    expect(data.jobs.map((j: any) => j.id)).toEqual(['job-4', 'job-3']);
  });

  it('limit=0 returns all jobs', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ id: `job-${i}`, startedAt: i })
    );
    listJobsMock.mockReturnValue(jobs);

    const req = new NextRequest('http://localhost/api/jobs?limit=0');
    const res = await GET(req);
    const data = await res.json();
    expect(data.jobs).toHaveLength(5);
  });

  it('probes only the limited slice of jobs', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ id: `job-${i}`, startedAt: i })
    );
    listJobsMock.mockReturnValue(jobs);

    const req = new NextRequest('http://localhost/api/jobs?limit=2');
    const res = await GET(req);
    const data = await res.json();
    expect(data.total).toBe(5);
    expect(probeJobStatusMock).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/jobs/[jobId]', () => {
  let GET: any;
  let getJobMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let jobToDictMock: ReturnType<typeof vi.fn>;
  let readParsedLogMock: ReturnType<typeof vi.fn>;
  let readLogMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getJobMock = vi.fn().mockReturnValue(null);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    jobToDictMock = vi.fn().mockImplementation((j: JobData) => ({
      id: j.id,
      project: j.project,
      kind: j.kind,
      status: j.finishedAt ? 'done' : 'running',
    }));
    readParsedLogMock = vi.fn().mockReturnValue('parsed log content');
    readLogMock = vi.fn().mockReturnValue('raw log content');

    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
      probeJobStatus: probeJobStatusMock,
      jobToDict: jobToDictMock,
      readParsedLog: readParsedLogMock,
      readLog: readLogMock,
    }));

    const mod = await import('@/app/api/jobs/[jobId]/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 for nonexistent job', async () => {
    const req = new NextRequest('http://localhost/api/jobs/nonexistent');
    const res = await GET(req, { params: Promise.resolve({ jobId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('nonexistent');
  });

  it('returns job data with parsed log for Claude-kind jobs', async () => {
    const job = makeJob({ id: 'job-123', finishedAt: 2000, exitCode: 0 });
    getJobMock.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/job-123');
    const res = await GET(req, { params: Promise.resolve({ jobId: 'job-123' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe('job-123');
    expect(data.log).toBe('parsed log content');
    expect(readLogMock).not.toHaveBeenCalled();
  });

  it('returns RAW log for release jobs (aggregated pipeline output)', async () => {
    // Release log is an aggregate of child logs (plain test output + NDJSON
    // review + plain commit/push). readParsedLog would silently drop the
    // plain-text sections; the API must serve raw so the terminal shows
    // the full pipeline output.
    const job = makeJob({ id: 'rel-1', kind: 'release', finishedAt: 2000, exitCode: 0 });
    getJobMock.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/rel-1');
    const res = await GET(req, { params: Promise.resolve({ jobId: 'rel-1' }) });
    const data = await res.json();
    expect(data.log).toBe('raw log content');
    expect(readLogMock).toHaveBeenCalledWith(job);
    expect(readParsedLogMock).not.toHaveBeenCalled();
  });

  it('calls probeJobStatus before returning', async () => {
    const job = makeJob({ id: 'job-abc' });
    getJobMock.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/job-abc');
    await GET(req, { params: Promise.resolve({ jobId: 'job-abc' }) });
    expect(probeJobStatusMock).toHaveBeenCalledWith(job);
  });
});

describe('POST /api/jobs/[jobId]/seen', () => {
  let POST: any;
  let markSeenMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    markSeenMock = vi.fn().mockReturnValue(true);

    vi.doMock('@/lib/jobs/job-storage', () => ({
      markSeen: markSeenMock,
    }));

    const mod = await import('@/app/api/jobs/[jobId]/seen/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 for nonexistent job', async () => {
    markSeenMock.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/jobs/nonexistent/seen', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('nonexistent');
  });

  it('marks job as seen and returns ok', async () => {
    const req = new NextRequest('http://localhost/api/jobs/job-123/seen', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-123' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(markSeenMock).toHaveBeenCalledWith('job-123');
  });
});

describe('GET /api/jobs/notifications', () => {
  let GET: any;
  let unseenFinishedMock: ReturnType<typeof vi.fn>;
  let jobToDictMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    unseenFinishedMock = vi.fn().mockReturnValue([]);
    jobToDictMock = vi.fn().mockImplementation((j: JobData) => ({ id: j.id }));
    probeJobStatusMock = vi.fn().mockResolvedValue('running');

    vi.doMock('@/lib/jobs/job-storage', () => ({
      unseenFinished: unseenFinishedMock,
      jobToDict: jobToDictMock,
      listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: probeJobStatusMock,
    }));

    const mod = await import('@/app/api/jobs/notifications/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns count 0 with empty jobs when no unseen jobs', async () => {
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(0);
    expect(data.jobs).toEqual([]);
  });

  it('returns count and jobs for unseen finished jobs', async () => {
    const job1 = makeJob({ id: 'job-1', finishedAt: 2000 });
    const job2 = makeJob({ id: 'job-2', finishedAt: 3000 });
    unseenFinishedMock.mockReturnValue([job1, job2]);

    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(2);
    expect(data.jobs).toHaveLength(2);
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

    vi.doMock('@/lib/jobs/job-storage', () => ({
      unseenFinished: unseenFinishedMock,
      markSeen: markSeenMock,
    }));

    const mod = await import('@/app/api/jobs/notifications/mark-seen/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns ok when no unseen jobs', async () => {
    const res = await POST();
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(markSeenMock).not.toHaveBeenCalled();
  });

  it('marks all unseen jobs as seen', async () => {
    const job1 = makeJob({ id: 'job-1' });
    const job2 = makeJob({ id: 'job-2' });
    unseenFinishedMock.mockReturnValue([job1, job2]);

    const res = await POST();
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(markSeenMock).toHaveBeenCalledTimes(2);
    expect(markSeenMock).toHaveBeenCalledWith('job-1');
    expect(markSeenMock).toHaveBeenCalledWith('job-2');
  });
});

describe('DELETE /api/jobs/[jobId]', () => {
  let DELETE: any;
  let getJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let requestJobCancellationMock: ReturnType<typeof vi.fn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();

    getJobMock = vi.fn().mockReturnValue(null);
    updateJobMock = vi.fn();
    execMock = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    requestJobCancellationMock = vi.fn().mockResolvedValue(true);

    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
      updateJob: updateJobMock,
    }));

    vi.doMock('@/lib/shared/shell', () => ({
      exec: execMock,
    }));
    vi.doMock('@/lib/jobs/cancellation', () => ({
      requestJobCancellation: requestJobCancellationMock,
      SAFE_PID_FLOOR: 100,
      shouldSignalJobPid: (job: { pid: number; kind: string }) => job.pid > 100 && job.kind !== 'push' && job.kind !== 'commit',
    }));

    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const mod = await import('@/app/api/jobs/[jobId]/route');
    DELETE = mod.DELETE;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    killSpy.mockRestore();
  });

  it('returns 404 for nonexistent job', async () => {
    const req = new NextRequest('http://localhost/api/jobs/nonexistent', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ jobId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('nonexistent');
  });

  it('returns 409 for already-finished job', async () => {
    const job = makeJob({ id: 'done-job', finishedAt: 9999 });
    getJobMock.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/done-job', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ jobId: 'done-job' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('already finished');
  });

  it('returns cancelled status for running job', async () => {
    const job = makeJob({ id: 'running-job', finishedAt: null });
    getJobMock.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/running-job', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ jobId: 'running-job' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('cancelled');
  });

  it('calls pm2 stop and delete for running job', async () => {
    const job = makeJob({ id: 'pm2-job', finishedAt: null });
    getJobMock.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/pm2-job', { method: 'DELETE' });
    await DELETE(req, { params: Promise.resolve({ jobId: 'pm2-job' }) });

    expect(execMock).toHaveBeenCalledWith('pm2', ['stop', 'pm2-job', '--silent'], { timeout: 5000 });
    expect(execMock).toHaveBeenCalledWith('pm2', ['delete', 'pm2-job', '--silent'], { timeout: 5000 });
  });

  it('sends SIGTERM to process by PID', async () => {
    const job = makeJob({ id: 'pid-job', pid: 5678, finishedAt: null });
    getJobMock.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/pid-job', { method: 'DELETE' });
    await DELETE(req, { params: Promise.resolve({ jobId: 'pid-job' }) });

    expect(killSpy).toHaveBeenCalledWith(5678, 'SIGTERM');
  });

  it('uses cooperative cancellation for inline push jobs', async () => {
    const job = makeJob({ id: 'inline-push', kind: 'push', pid: 999, finishedAt: null });
    getJobMock.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/inline-push', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ jobId: 'inline-push' }) });

    expect(res.status).toBe(200);
    expect(requestJobCancellationMock).toHaveBeenCalledWith('inline-push', 20_000);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('returns 409 when inline cancellation times out', async () => {
    const job = makeJob({ id: 'inline-commit', kind: 'commit', pid: 999, finishedAt: null });
    getJobMock.mockReturnValue(job);
    requestJobCancellationMock.mockResolvedValue(false);

    const req = new NextRequest('http://localhost/api/jobs/inline-commit', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ jobId: 'inline-commit' }) });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('stop cleanly');
    expect(job.finishedAt).toBeNull();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('sends SIGKILL after 2s timeout', async () => {
    const job = makeJob({ id: 'kill-job', pid: 9999, finishedAt: null });
    getJobMock.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/kill-job', { method: 'DELETE' });
    await DELETE(req, { params: Promise.resolve({ jobId: 'kill-job' }) });

    expect(killSpy).not.toHaveBeenCalledWith(9999, 'SIGKILL');
    vi.advanceTimersByTime(2000);
    expect(killSpy).toHaveBeenCalledWith(9999, 'SIGKILL');
  });

  it('sets exitCode -2 and finishedAt on the job', async () => {
    const job = makeJob({ id: 'update-job', finishedAt: null });
    getJobMock.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/update-job', { method: 'DELETE' });
    await DELETE(req, { params: Promise.resolve({ jobId: 'update-job' }) });

    expect(job.exitCode).toBe(-2);
    expect(job.finishedAt).toBeGreaterThan(0);
    expect(updateJobMock).toHaveBeenCalledWith(job);
  });

  it('continues cancellation even when pm2 commands fail', async () => {
    const job = makeJob({ id: 'no-pm2-job', pid: 1111, finishedAt: null });
    getJobMock.mockReturnValue(job);
    execMock.mockRejectedValue(new Error('pm2 not found'));

    const req = new NextRequest('http://localhost/api/jobs/no-pm2-job', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ jobId: 'no-pm2-job' }) });

    expect(res.status).toBe(200);
    expect(killSpy).toHaveBeenCalledWith(1111, 'SIGTERM');
    expect(updateJobMock).toHaveBeenCalled();
  });

  it('skips kill when pid is 0', async () => {
    const job = makeJob({ id: 'no-pid-job', pid: 0, finishedAt: null });
    getJobMock.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/no-pid-job', { method: 'DELETE' });
    await DELETE(req, { params: Promise.resolve({ jobId: 'no-pid-job' }) });

    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/streaming/[jobId]', () => {
  let GET: any;
  let getJobMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-streaming-test-'));

    getJobMock = vi.fn().mockReturnValue(null);

    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
    }));

    vi.doMock('@/lib/jobs/claude-stream-parser', () => ({
      parseStreamLines: vi.fn().mockReturnValue([]),
      createParseState: vi.fn().mockReturnValue({ currentToolName: '', currentToolInput: '', inToolUse: false, hasEmitted: false }),
    }));

    const mod = await import('@/app/api/streaming/[jobId]/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns SSE response with correct content-type', async () => {
    const req = new NextRequest('http://localhost/api/streaming/job-123');
    // abort immediately to avoid hanging
    const controller = new AbortController();
    controller.abort();
    const abortedReq = new NextRequest('http://localhost/api/streaming/job-123', {
      signal: controller.signal,
    });
    const res = await GET(abortedReq, { params: Promise.resolve({ jobId: 'job-123' }) });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });

  it('returns SSE response with correct cache-control', async () => {
    const controller = new AbortController();
    controller.abort();
    const req = new NextRequest('http://localhost/api/streaming/job-123', {
      signal: controller.signal,
    });
    const res = await GET(req, { params: Promise.resolve({ jobId: 'job-123' }) });
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('streams existing log content when log file exists', async () => {
    const logFile = join(tempDir, 'test-job.log');
    writeFileSync(logFile, 'line one\nline two\n');
    getJobMock.mockReturnValue({
      id: 'job-log',
      logPath: logFile,
    });

    const controller = new AbortController();
    // abort after a short delay to let the initial replay happen
    setTimeout(() => controller.abort(), 10);

    const req = new NextRequest('http://localhost/api/streaming/job-log', {
      signal: controller.signal,
    });
    const res = await GET(req, { params: Promise.resolve({ jobId: 'job-log' }) });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    // Can't easily read the stream body in tests, but we verify it's a response
    expect(res.body).toBeTruthy();
  });

  it('uses fallback log path when job has no logPath', async () => {
    getJobMock.mockReturnValue({
      id: 'job-no-log',
      logPath: null,
    });

    const controller = new AbortController();
    controller.abort();
    const req = new NextRequest('http://localhost/api/streaming/job-no-log', {
      signal: controller.signal,
    });
    const res = await GET(req, { params: Promise.resolve({ jobId: 'job-no-log' }) });
    // Should still return an SSE response, just with no content
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });

  it('uses fallback log path when job does not exist', async () => {
    getJobMock.mockReturnValue(null);

    const controller = new AbortController();
    controller.abort();
    const req = new NextRequest('http://localhost/api/streaming/missing-job', {
      signal: controller.signal,
    });
    const res = await GET(req, { params: Promise.resolve({ jobId: 'missing-job' }) });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });
});
