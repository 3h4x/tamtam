import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobData } from '@/lib/jobs/job-storage';

// All mocks are hoisted to top-level so route handlers can be imported once
// at module scope. Per-test behavior is configured by re-assigning mock
// return values in beforeEach.
const mocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  getJob: vi.fn(),
  probeJobStatus: vi.fn(),
  jobToDict: vi.fn(),
  jobToListDict: vi.fn(),
  readDisplayLog: vi.fn(),
  readLog: vi.fn(),
  markSeen: vi.fn(),
  unseenFinished: vi.fn(),
  updateJob: vi.fn(),
  exec: vi.fn(),
  getJobCancellationSignal: vi.fn(),
  requestJobCancellation: vi.fn(),
  listPendingReleaseProjects: vi.fn(),
  parseStreamLines: vi.fn(),
  createParseState: vi.fn(),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  listJobs: mocks.listJobs,
  getJob: mocks.getJob,
  probeJobStatus: mocks.probeJobStatus,
  jobToDict: mocks.jobToDict,
  jobToListDict: mocks.jobToListDict,
  readDisplayLog: mocks.readDisplayLog,
  readLog: mocks.readLog,
  markSeen: mocks.markSeen,
  unseenFinished: mocks.unseenFinished,
  updateJob: mocks.updateJob,
}));

vi.mock('@/lib/shared/shell', () => ({
  exec: mocks.exec,
}));

vi.mock('@/lib/jobs/cancellation', () => ({
  getJobCancellationSignal: mocks.getJobCancellationSignal,
  requestJobCancellation: mocks.requestJobCancellation,
  SAFE_PID_FLOOR: 100,
  shouldSignalJobPid: (job: { pid: number; kind: string }) =>
    job.pid > 100 && job.kind !== 'push' && job.kind !== 'commit',
}));

vi.mock('@/lib/pipeline/pending-release', () => ({
  listPendingReleaseProjects: mocks.listPendingReleaseProjects,
}));

vi.mock('@/lib/jobs/claude-stream-parser', () => ({
  parseStreamLines: mocks.parseStreamLines,
  createParseState: mocks.createParseState,
}));

// Import route handlers once at top-level — no per-test re-imports.
import { GET as jobsGET } from '@/app/api/jobs/route';
import { GET as jobCountsGET } from '@/app/api/jobs/counts/route';
import { GET as projectRuntimeGET } from '@/app/api/projects/runtime/route';
import { GET as jobGET, DELETE as jobDELETE } from '@/app/api/jobs/[jobId]/route';
import { POST as jobSeenPOST } from '@/app/api/jobs/[jobId]/seen/route';
import { GET as notificationsGET } from '@/app/api/jobs/notifications/route';
import { POST as markSeenPOST } from '@/app/api/jobs/notifications/mark-seen/route';
import { GET as streamingGET } from '@/app/api/streaming/[jobId]/route';

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

// Default behaviors shared by all describes. Each describe still overrides as needed.
function resetDefaults() {
  mocks.listJobs.mockReset().mockReturnValue([]);
  mocks.getJob.mockReset().mockReturnValue(null);
  mocks.probeJobStatus.mockReset().mockResolvedValue('done');
  mocks.jobToDict.mockReset().mockImplementation((j: JobData) => ({
    id: j.id,
    project: j.project,
    kind: j.kind,
    status: j.finishedAt ? 'done' : 'running',
  }));
  mocks.jobToListDict.mockReset().mockImplementation((j: JobData) => ({
    id: j.id,
    project: j.project,
    kind: j.kind,
    status: j.finishedAt ? 'done' : 'running',
  }));
  mocks.readDisplayLog.mockReset().mockReturnValue('display log content');
  mocks.readLog.mockReset().mockReturnValue('raw log content');
  mocks.markSeen.mockReset().mockReturnValue(true);
  mocks.unseenFinished.mockReset().mockReturnValue([]);
  mocks.updateJob.mockReset();
  mocks.exec.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  mocks.getJobCancellationSignal.mockReset().mockReturnValue(null);
  mocks.requestJobCancellation.mockReset().mockResolvedValue(true);
  mocks.listPendingReleaseProjects.mockReset().mockResolvedValue([]);
  mocks.parseStreamLines.mockReset().mockReturnValue([]);
  mocks.createParseState.mockReset().mockReturnValue({
    currentToolName: '',
    currentToolInput: '',
    inToolUse: false,
    hasEmitted: false,
  });
}

describe('GET /api/jobs', () => {
  beforeEach(() => {
    resetDefaults();
  });

  it('returns empty jobs list', async () => {
    const req = new NextRequest('http://localhost/api/jobs');
    const res = await jobsGET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobs).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('returns all jobs', async () => {
    const job1 = makeJob({ id: 'job-1', project: 'proj1' });
    const job2 = makeJob({ id: 'job-2', project: 'proj2' });
    mocks.listJobs.mockReturnValue([job1, job2]);

    const req = new NextRequest('http://localhost/api/jobs');
    const res = await jobsGET(req);
    const data = await res.json();
    expect(data.jobs).toHaveLength(2);
    expect(data.total).toBe(2);
    expect(data.jobs[0].id).toBe('job-1');
    expect(data.jobs[1].id).toBe('job-2');
  });

  it('filters by project query param', async () => {
    const job1 = makeJob({ id: 'job-1', project: 'proj1' });
    const job2 = makeJob({ id: 'job-2', project: 'proj2' });
    mocks.listJobs.mockReturnValue([job1, job2]);

    const req = new NextRequest('http://localhost/api/jobs?project=proj1');
    const res = await jobsGET(req);
    const data = await res.json();
    expect(data.jobs).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.jobs[0].id).toBe('job-1');
  });

  it('calls probeJobStatus for each job', async () => {
    const job1 = makeJob({ id: 'job-1' });
    const job2 = makeJob({ id: 'job-2' });
    mocks.listJobs.mockReturnValue([job1, job2]);

    const req = new NextRequest('http://localhost/api/jobs');
    await jobsGET(req);
    expect(mocks.probeJobStatus).toHaveBeenCalledTimes(2);
  });

  it('returns empty list when project filter matches nothing', async () => {
    const job1 = makeJob({ id: 'job-1', project: 'proj1' });
    mocks.listJobs.mockReturnValue([job1]);

    const req = new NextRequest('http://localhost/api/jobs?project=nonexistent');
    const res = await jobsGET(req);
    const data = await res.json();
    expect(data.jobs).toEqual([]);
  });

  it('sorts jobs newest-first by startedAt', async () => {
    const old = makeJob({ id: 'old', startedAt: 100 });
    const mid = makeJob({ id: 'mid', startedAt: 500 });
    const newest = makeJob({ id: 'new', startedAt: 900 });
    mocks.listJobs.mockReturnValue([old, newest, mid]);

    const req = new NextRequest('http://localhost/api/jobs');
    const res = await jobsGET(req);
    const data = await res.json();
    expect(data.jobs.map((j: any) => j.id)).toEqual(['new', 'mid', 'old']);
  });

  it('respects explicit limit param', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ id: `job-${i}`, startedAt: i })
    );
    mocks.listJobs.mockReturnValue(jobs);

    const req = new NextRequest('http://localhost/api/jobs?limit=3');
    const res = await jobsGET(req);
    const data = await res.json();
    expect(data.jobs).toHaveLength(3);
    expect(data.total).toBe(5);
  });

  it('limit applies to newest jobs — oldest are dropped', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ id: `job-${i}`, startedAt: i })
    );
    mocks.listJobs.mockReturnValue(jobs);

    const req = new NextRequest('http://localhost/api/jobs?limit=2');
    const res = await jobsGET(req);
    const data = await res.json();
    expect(data.jobs.map((j: any) => j.id)).toEqual(['job-4', 'job-3']);
  });

  it('limit=0 returns all jobs', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ id: `job-${i}`, startedAt: i })
    );
    mocks.listJobs.mockReturnValue(jobs);

    const req = new NextRequest('http://localhost/api/jobs?limit=0');
    const res = await jobsGET(req);
    const data = await res.json();
    expect(data.jobs).toHaveLength(5);
  });

  it('probes only the limited slice of jobs', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ id: `job-${i}`, startedAt: i })
    );
    mocks.listJobs.mockReturnValue(jobs);

    const req = new NextRequest('http://localhost/api/jobs?limit=2');
    const res = await jobsGET(req);
    const data = await res.json();
    expect(data.total).toBe(5);
    expect(mocks.probeJobStatus).toHaveBeenCalledTimes(2);
  });

  it('returns offset pages after sorting newest-first', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ id: `job-${i}`, startedAt: i })
    );
    mocks.listJobs.mockReturnValue(jobs);

    const req = new NextRequest('http://localhost/api/jobs?limit=2&offset=2');
    const res = await jobsGET(req);
    const data = await res.json();
    expect(data.jobs.map((j: any) => j.id)).toEqual(['job-2', 'job-1']);
    expect(data.total).toBe(5);
    expect(data.nextOffset).toBe(4);
    expect(mocks.probeJobStatus).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/jobs/counts', () => {
  beforeEach(() => {
    resetDefaults();
  });

  it('classifies review attention verdicts as failed counts', async () => {
    mocks.listJobs.mockReturnValue([
      makeJob({ id: 'review-lgtm', kind: 'review', finishedAt: 100, exitCode: 0, verdict: 'LGTM' }),
      makeJob({ id: 'review-attn', kind: 'review', finishedAt: 100, exitCode: 0, verdict: 'NEEDS ATTENTION' }),
      makeJob({ id: 'review-dns', kind: 'review', finishedAt: 100, exitCode: 0, verdict: 'DO NOT SHIP' }),
      makeJob({ id: 'review-missing', kind: 'review', finishedAt: 100, exitCode: 0, verdict: null }),
      makeJob({ id: 'test-failed', kind: 'test', finishedAt: 100, exitCode: 1 }),
      makeJob({ id: 'aborted', kind: 'run', finishedAt: 100, exitCode: -3, abortedAt: 100 }),
    ]);

    const req = new NextRequest('http://localhost/api/jobs/counts');
    const res = await jobCountsGET(req);
    const data = await res.json();

    expect(data.total).toBe(6);
    expect(data.byStatus).toMatchObject({
      running: 0,
      done: 1,
      failed: 4,
      aborted: 1,
    });
  });
});

describe('GET /api/projects/runtime', () => {
  beforeEach(() => {
    resetDefaults();
  });

  it('returns per-project running state, latest verdict, and last job snapshot', async () => {
    mocks.listJobs.mockReturnValue([
      makeJob({
        id: 'alpha-old-review',
        project: 'alpha',
        kind: 'review',
        startedAt: 100,
        finishedAt: 120,
        exitCode: 0,
        verdict: 'LGTM',
      }),
      makeJob({
        id: 'alpha-latest-review',
        project: 'alpha',
        kind: 'review',
        startedAt: 200,
        finishedAt: 240,
        exitCode: 0,
        verdict: 'NEEDS ATTENTION',
      }),
      makeJob({
        id: 'alpha-running-agent',
        project: 'alpha',
        kind: 'agent:reviewer',
        startedAt: 300,
        finishedAt: null,
        exitCode: null,
      }),
      makeJob({
        id: 'alpha-running-test',
        project: 'alpha',
        kind: 'test',
        startedAt: 310,
        finishedAt: null,
        exitCode: null,
      }),
      makeJob({
        id: 'beta-running-release',
        project: 'beta',
        kind: 'release',
        startedAt: 400,
        finishedAt: null,
        exitCode: null,
      }),
      makeJob({
        id: 'beta-aborted-run',
        project: 'beta',
        kind: 'run',
        startedAt: 390,
        finishedAt: 405,
        exitCode: -3,
        verdict: null,
        abortedAt: 405,
      }),
    ]);

    const res = await projectRuntimeGET();
    const data = await res.json();

    expect(data.projects.alpha).toMatchObject({
      hasRunningReview: false,
      hasRunningTest: true,
      hasRunningRelease: false,
      hasRunningPipelineChild: true,
      runningCount: 2,
      runningKinds: ['agent:reviewer', 'test'],
      runningAgentNames: ['reviewer'],
      latestVerdict: 'NEEDS ATTENTION',
      latestVerdictAt: 240,
      lastActivityAt: 310,
      lastJob: {
        id: 'alpha-running-test',
        kind: 'test',
        status: 'running',
        exitCode: null,
        startedAt: 310,
        finishedAt: null,
        verdict: null,
      },
    });
    expect(data.projects.beta).toMatchObject({
      hasRunningRelease: true,
      runningCount: 1,
      runningKinds: ['release'],
      runningAgentNames: [],
      lastActivityAt: 405,
      lastJob: {
        id: 'beta-aborted-run',
        kind: 'run',
        status: 'aborted',
        exitCode: -3,
        startedAt: 390,
        finishedAt: 405,
        verdict: null,
      },
    });
  });
});

describe('GET /api/jobs/[jobId]', () => {
  beforeEach(() => {
    resetDefaults();
  });

  it('returns 404 for nonexistent job', async () => {
    const req = new NextRequest('http://localhost/api/jobs/nonexistent');
    const res = await jobGET(req, { params: Promise.resolve({ jobId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('nonexistent');
  });

  it('returns job data with display log for Claude-kind jobs', async () => {
    const job = makeJob({ id: 'job-123', finishedAt: 2000, exitCode: 0 });
    mocks.getJob.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/job-123');
    const res = await jobGET(req, { params: Promise.resolve({ jobId: 'job-123' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe('job-123');
    expect(data.log).toBe('display log content');
    expect(mocks.readLog).not.toHaveBeenCalled();
  });

  it('returns RAW log for release jobs (aggregated pipeline output)', async () => {
    // Release log is an aggregate of child logs (plain test output + NDJSON
    // review + plain commit/push). readParsedLog would silently drop the
    // plain-text sections; the API must serve raw so the terminal shows
    // the full pipeline output.
    const job = makeJob({ id: 'rel-1', kind: 'release', finishedAt: 2000, exitCode: 0 });
    mocks.getJob.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/rel-1');
    const res = await jobGET(req, { params: Promise.resolve({ jobId: 'rel-1' }) });
    const data = await res.json();
    expect(data.log).toBe('raw log content');
    expect(mocks.readLog).toHaveBeenCalledWith(job);
    expect(mocks.readDisplayLog).not.toHaveBeenCalled();
  });

  it('calls probeJobStatus before returning', async () => {
    const job = makeJob({ id: 'job-abc' });
    mocks.getJob.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/job-abc');
    await jobGET(req, { params: Promise.resolve({ jobId: 'job-abc' }) });
    expect(mocks.probeJobStatus).toHaveBeenCalledWith(job);
  });
});

describe('POST /api/jobs/[jobId]/seen', () => {
  beforeEach(() => {
    resetDefaults();
  });

  it('returns 404 for nonexistent job', async () => {
    mocks.markSeen.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/jobs/nonexistent/seen', {
      method: 'POST',
    });
    const res = await jobSeenPOST(req, { params: Promise.resolve({ jobId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('nonexistent');
  });

  it('marks job as seen and returns ok', async () => {
    const req = new NextRequest('http://localhost/api/jobs/job-123/seen', {
      method: 'POST',
    });
    const res = await jobSeenPOST(req, { params: Promise.resolve({ jobId: 'job-123' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(mocks.markSeen).toHaveBeenCalledWith('job-123');
  });
});

describe('GET /api/jobs/notifications', () => {
  beforeEach(() => {
    resetDefaults();
    mocks.probeJobStatus.mockResolvedValue('running');
    mocks.jobToDict.mockImplementation((j: JobData) => ({ id: j.id }));
  });

  it('returns count 0 with empty jobs when no unseen jobs', async () => {
    const res = await notificationsGET();
    const data = await res.json();
    expect(data.count).toBe(0);
    expect(data.jobs).toEqual([]);
  });

  it('returns count and jobs for unseen finished jobs', async () => {
    const job1 = makeJob({ id: 'job-1', finishedAt: 2000 });
    const job2 = makeJob({ id: 'job-2', finishedAt: 3000 });
    mocks.unseenFinished.mockReturnValue([job1, job2]);

    const res = await notificationsGET();
    const data = await res.json();
    expect(data.count).toBe(2);
    expect(data.jobs).toHaveLength(2);
  });
});

describe('POST /api/jobs/notifications/mark-seen', () => {
  beforeEach(() => {
    resetDefaults();
  });

  it('returns ok when no unseen jobs', async () => {
    const res = await markSeenPOST();
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(mocks.markSeen).not.toHaveBeenCalled();
  });

  it('marks all unseen jobs as seen', async () => {
    const job1 = makeJob({ id: 'job-1' });
    const job2 = makeJob({ id: 'job-2' });
    mocks.unseenFinished.mockReturnValue([job1, job2]);

    const res = await markSeenPOST();
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(mocks.markSeen).toHaveBeenCalledTimes(2);
    expect(mocks.markSeen).toHaveBeenCalledWith('job-1');
    expect(mocks.markSeen).toHaveBeenCalledWith('job-2');
  });
});

describe('DELETE /api/jobs/[jobId]', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetDefaults();
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    killSpy.mockRestore();
  });

  it('returns 404 for nonexistent job', async () => {
    const req = new NextRequest('http://localhost/api/jobs/nonexistent', { method: 'DELETE' });
    const res = await jobDELETE(req, { params: Promise.resolve({ jobId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('nonexistent');
  });

  it('returns 409 for already-finished job', async () => {
    const job = makeJob({ id: 'done-job', finishedAt: 9999 });
    mocks.getJob.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/done-job', { method: 'DELETE' });
    const res = await jobDELETE(req, { params: Promise.resolve({ jobId: 'done-job' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('already finished');
  });

  it('returns cancelled status for running job', async () => {
    const job = makeJob({ id: 'running-job', finishedAt: null });
    mocks.getJob.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/running-job', { method: 'DELETE' });
    const res = await jobDELETE(req, { params: Promise.resolve({ jobId: 'running-job' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('cancelled');
  });

  it('calls pm2 stop and delete for running job', async () => {
    const job = makeJob({ id: 'pm2-job', finishedAt: null });
    mocks.getJob.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/pm2-job', { method: 'DELETE' });
    await jobDELETE(req, { params: Promise.resolve({ jobId: 'pm2-job' }) });

    expect(mocks.exec).toHaveBeenCalledWith('pm2', ['stop', 'pm2-job', '--silent'], { timeout: 5000 });
    expect(mocks.exec).toHaveBeenCalledWith('pm2', ['delete', 'pm2-job', '--silent'], { timeout: 5000 });
  });

  it('sends SIGTERM to process by PID', async () => {
    const job = makeJob({ id: 'pid-job', pid: 5678, finishedAt: null });
    mocks.getJob.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/pid-job', { method: 'DELETE' });
    await jobDELETE(req, { params: Promise.resolve({ jobId: 'pid-job' }) });

    expect(killSpy).toHaveBeenCalledWith(5678, 'SIGTERM');
  });

  it('uses cooperative cancellation for inline push jobs', async () => {
    const job = makeJob({ id: 'inline-push', kind: 'push', pid: 999, finishedAt: null });
    mocks.getJob.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/inline-push', { method: 'DELETE' });
    const res = await jobDELETE(req, { params: Promise.resolve({ jobId: 'inline-push' }) });

    expect(res.status).toBe(200);
    expect(mocks.requestJobCancellation).toHaveBeenCalledWith('inline-push', 20_000);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('uses cooperative cancellation for agent placeholder jobs with a registered signal', async () => {
    const job = makeJob({ id: 'agent-prereq', kind: 'agent:Test Agent', pid: 0, finishedAt: null });
    mocks.getJob.mockReturnValue(job);
    mocks.getJobCancellationSignal.mockReturnValue(new AbortController().signal);

    const req = new NextRequest('http://localhost/api/jobs/agent-prereq', { method: 'DELETE' });
    const res = await jobDELETE(req, { params: Promise.resolve({ jobId: 'agent-prereq' }) });

    expect(res.status).toBe(200);
    expect(mocks.requestJobCancellation).toHaveBeenCalledWith('agent-prereq', 20_000);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('returns 409 when inline cancellation times out', async () => {
    const job = makeJob({ id: 'inline-commit', kind: 'commit', pid: 999, finishedAt: null });
    mocks.getJob.mockReturnValue(job);
    mocks.requestJobCancellation.mockResolvedValue(false);

    const req = new NextRequest('http://localhost/api/jobs/inline-commit', { method: 'DELETE' });
    const res = await jobDELETE(req, { params: Promise.resolve({ jobId: 'inline-commit' }) });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('stop cleanly');
    expect(job.finishedAt).toBeNull();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('sends SIGKILL after 2s timeout', async () => {
    const job = makeJob({ id: 'kill-job', pid: 9999, finishedAt: null });
    mocks.getJob.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/kill-job', { method: 'DELETE' });
    await jobDELETE(req, { params: Promise.resolve({ jobId: 'kill-job' }) });

    expect(killSpy).not.toHaveBeenCalledWith(9999, 'SIGKILL');
    vi.advanceTimersByTime(2000);
    expect(killSpy).toHaveBeenCalledWith(9999, 'SIGKILL');
  });

  it('sets exitCode -2 and finishedAt on the job', async () => {
    const job = makeJob({ id: 'update-job', finishedAt: null });
    mocks.getJob.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/update-job', { method: 'DELETE' });
    await jobDELETE(req, { params: Promise.resolve({ jobId: 'update-job' }) });

    expect(job.exitCode).toBe(-2);
    expect(job.finishedAt).toBeGreaterThan(0);
    expect(mocks.updateJob).toHaveBeenCalledWith(job);
  });

  it('continues cancellation even when pm2 commands fail', async () => {
    const job = makeJob({ id: 'no-pm2-job', pid: 1111, finishedAt: null });
    mocks.getJob.mockReturnValue(job);
    mocks.exec.mockRejectedValue(new Error('pm2 not found'));

    const req = new NextRequest('http://localhost/api/jobs/no-pm2-job', { method: 'DELETE' });
    const res = await jobDELETE(req, { params: Promise.resolve({ jobId: 'no-pm2-job' }) });

    expect(res.status).toBe(200);
    expect(killSpy).toHaveBeenCalledWith(1111, 'SIGTERM');
    expect(mocks.updateJob).toHaveBeenCalled();
  });

  it('skips kill when pid is 0', async () => {
    const job = makeJob({ id: 'no-pid-job', pid: 0, finishedAt: null });
    mocks.getJob.mockReturnValue(job);

    const req = new NextRequest('http://localhost/api/jobs/no-pid-job', { method: 'DELETE' });
    await jobDELETE(req, { params: Promise.resolve({ jobId: 'no-pid-job' }) });

    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/streaming/[jobId]', () => {
  let tempDir: string;

  beforeEach(() => {
    resetDefaults();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-streaming-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns SSE response with correct content-type', async () => {
    // abort immediately to avoid hanging
    const controller = new AbortController();
    controller.abort();
    const abortedReq = new NextRequest('http://localhost/api/streaming/job-123', {
      signal: controller.signal,
    });
    const res = await streamingGET(abortedReq, { params: Promise.resolve({ jobId: 'job-123' }) });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });

  it('returns SSE response with correct cache-control', async () => {
    const controller = new AbortController();
    controller.abort();
    const req = new NextRequest('http://localhost/api/streaming/job-123', {
      signal: controller.signal,
    });
    const res = await streamingGET(req, { params: Promise.resolve({ jobId: 'job-123' }) });
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('streams existing log content when log file exists', async () => {
    const logFile = join(tempDir, 'test-job.log');
    writeFileSync(logFile, 'line one\nline two\n');
    mocks.getJob.mockReturnValue({
      id: 'job-log',
      logPath: logFile,
    });

    const controller = new AbortController();
    // abort after a short delay to let the initial replay happen
    setTimeout(() => controller.abort(), 10);

    const req = new NextRequest('http://localhost/api/streaming/job-log', {
      signal: controller.signal,
    });
    const res = await streamingGET(req, { params: Promise.resolve({ jobId: 'job-log' }) });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    // Can't easily read the stream body in tests, but we verify it's a response
    expect(res.body).toBeTruthy();
  });

  it('uses fallback log path when job has no logPath', async () => {
    mocks.getJob.mockReturnValue({
      id: 'job-no-log',
      logPath: null,
    });

    const controller = new AbortController();
    controller.abort();
    const req = new NextRequest('http://localhost/api/streaming/job-no-log', {
      signal: controller.signal,
    });
    const res = await streamingGET(req, { params: Promise.resolve({ jobId: 'job-no-log' }) });
    // Should still return an SSE response, just with no content
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });

  it('uses fallback log path when job does not exist', async () => {
    mocks.getJob.mockReturnValue(null);

    const controller = new AbortController();
    controller.abort();
    const req = new NextRequest('http://localhost/api/streaming/missing-job', {
      signal: controller.signal,
    });
    const res = await streamingGET(req, { params: Promise.resolve({ jobId: 'missing-job' }) });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });
});
