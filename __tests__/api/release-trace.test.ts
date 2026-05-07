import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
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

describe('GET /api/projects/by-project/{name}/release/{releaseId}', () => {
  let GET: (req: NextRequest, ctx: { params: Promise<{ projectName: string; releaseId: string }> }) => Promise<Response>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let getVerdictMock: ReturnType<typeof vi.fn>;
  let readLogMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    listJobsMock = vi.fn().mockReturnValue([]);
    getVerdictMock = vi.fn().mockReturnValue(null);
    readLogMock = vi.fn().mockReturnValue('');
    resolveProjectPathMock = vi.fn().mockReturnValue('/workspace/proj1');
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'main', stderr: '' });

    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      getVerdict: getVerdictMock,
      readLog: readLogMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));

    const mod = await import(
      '@/app/api/projects/by-project/[projectName]/release/[releaseId]/route'
    );
    GET = mod.GET as typeof GET;
  });

  afterEach(() => vi.resetModules());

  function req(name = 'proj1') {
    return new NextRequest(`http://localhost/api/projects/by-project/${name}/release/rel-1`);
  }

  function params(name = 'proj1', releaseId = 'rel-1') {
    return { params: Promise.resolve({ projectName: name, releaseId }) };
  }

  it('returns 404 when no release job found', async () => {
    listJobsMock.mockReturnValue([]);
    const res = await GET(req(), params());
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('not found');
  });

  it('returns 404 when job exists but kind is not release', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'rel-1', project: 'proj1', kind: 'review', releaseId: 'rel-1' }),
    ]);
    const res = await GET(req(), params());
    expect(res.status).toBe(404);
  });

  it('returns 404 when release belongs to different project', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'rel-1', project: 'other-proj', kind: 'release', releaseId: 'rel-1' }),
    ]);
    const res = await GET(req('proj1'), params('proj1'));
    expect(res.status).toBe(404);
  });

  it('returns release with no steps when no child jobs share releaseId', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'rel-1', project: 'proj1', kind: 'release', startedAt: 1000, finishedAt: 1060, exitCode: 0 }),
    ]);
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.release_id).toBe('rel-1');
    expect(data.project).toBe('proj1');
    expect(data.branch).toBe('main');
    expect(data.started_at).toBe(1000);
    expect(data.finished_at).toBe(1060);
    expect(data.exit_code).toBe(0);
    expect(data.steps).toEqual([]);
  });

  it('aggregates pipeline step jobs that share the releaseId', async () => {
    const testJob = makeJob({ id: 'test-1', project: 'proj1', kind: 'test', startedAt: 1001, finishedAt: 1020, exitCode: 0, releaseId: 'rel-1' });
    const reviewJob = makeJob({ id: 'review-1', project: 'proj1', kind: 'review', startedAt: 1021, finishedAt: 1050, exitCode: 0, releaseId: 'rel-1' });
    const releaseJob = makeJob({ id: 'rel-1', project: 'proj1', kind: 'release', startedAt: 1000, finishedAt: 1060, exitCode: 0 });

    listJobsMock.mockReturnValue([releaseJob, testJob, reviewJob]);
    getVerdictMock.mockImplementation((j: JobData) => j.id === 'review-1' ? 'LGTM' : null);
    readLogMock.mockReturnValue('test output');

    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.steps).toHaveLength(2);
    expect(data.steps[0].job_id).toBe('test-1');
    expect(data.steps[0].kind).toBe('test');
    expect(data.steps[0].status).toBe('done');
    expect(data.steps[0].exit_code).toBe(0);
    expect(data.steps[1].job_id).toBe('review-1');
    expect(data.steps[1].kind).toBe('review');
    expect(data.steps[1].verdict).toBe('LGTM');
  });

  it('excludes jobs from other projects or with different releaseId', async () => {
    const releaseJob = makeJob({ id: 'rel-1', project: 'proj1', kind: 'release', startedAt: 1000 });
    const ownStep = makeJob({ id: 'test-1', project: 'proj1', kind: 'test', startedAt: 1001, releaseId: 'rel-1' });
    const otherProj = makeJob({ id: 'test-2', project: 'other', kind: 'test', startedAt: 1001, releaseId: 'rel-1' });
    const differentRelease = makeJob({ id: 'test-3', project: 'proj1', kind: 'test', startedAt: 1001, releaseId: 'rel-999' });

    listJobsMock.mockReturnValue([releaseJob, ownStep, otherProj, differentRelease]);

    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0].job_id).toBe('test-1');
  });

  it('returns running steps with status running when finishedAt is null', async () => {
    const releaseJob = makeJob({ id: 'rel-1', project: 'proj1', kind: 'release', startedAt: 1000 });
    const runningStep = makeJob({ id: 'review-1', project: 'proj1', kind: 'review', startedAt: 1001, finishedAt: null, exitCode: null, releaseId: 'rel-1' });

    listJobsMock.mockReturnValue([releaseJob, runningStep]);

    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.steps[0].status).toBe('running');
    expect(data.finished_at).toBeNull();
  });

  it('preserves aborted status for the release and its step jobs', async () => {
    const releaseJob = makeJob({
      id: 'rel-1',
      project: 'proj1',
      kind: 'release',
      startedAt: 1000,
      finishedAt: 1040,
      exitCode: -3,
      abortedAt: 1035,
    });
    const abortedStep = makeJob({
      id: 'review-1',
      project: 'proj1',
      kind: 'review',
      startedAt: 1001,
      finishedAt: 1030,
      exitCode: -3,
      abortedAt: 1029,
      releaseId: 'rel-1',
    });

    listJobsMock.mockReturnValue([releaseJob, abortedStep]);

    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('aborted');
    expect(data.steps[0].status).toBe('aborted');
    expect(data.steps[0].exit_code).toBe(-3);
  });

  it('orders steps by startedAt ascending', async () => {
    const releaseJob = makeJob({ id: 'rel-1', project: 'proj1', kind: 'release', startedAt: 1000 });
    const commit = makeJob({ id: 'commit-1', project: 'proj1', kind: 'commit', startedAt: 1050, finishedAt: 1055, exitCode: 0, releaseId: 'rel-1' });
    const test = makeJob({ id: 'test-1', project: 'proj1', kind: 'test', startedAt: 1001, finishedAt: 1020, exitCode: 0, releaseId: 'rel-1' });
    const review = makeJob({ id: 'review-1', project: 'proj1', kind: 'review', startedAt: 1021, finishedAt: 1049, exitCode: 0, releaseId: 'rel-1' });

    listJobsMock.mockReturnValue([commit, test, review, releaseJob]);

    const res = await GET(req(), params());
    const data = await res.json();
    expect(data.steps.map((s: { kind: string }) => s.kind)).toEqual(['test', 'review', 'commit']);
  });

  it('handles git branch resolution failure gracefully', async () => {
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not a git repo' });
    listJobsMock.mockReturnValue([
      makeJob({ id: 'rel-1', project: 'proj1', kind: 'release', startedAt: 1000 }),
    ]);

    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branch).toBeNull();
  });

  it('handles missing project path gracefully', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    listJobsMock.mockReturnValue([
      makeJob({ id: 'rel-1', project: 'proj1', kind: 'release', startedAt: 1000 }),
    ]);

    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branch).toBeNull();
  });

  it('includes log excerpt in step data', async () => {
    readLogMock.mockReturnValue('this is the log output from the test run');
    const releaseJob = makeJob({ id: 'rel-1', project: 'proj1', kind: 'release', startedAt: 1000 });
    const testStep = makeJob({ id: 'test-1', project: 'proj1', kind: 'test', startedAt: 1001, finishedAt: 1010, exitCode: 0, releaseId: 'rel-1' });

    listJobsMock.mockReturnValue([releaseJob, testStep]);

    const res = await GET(req(), params());
    const data = await res.json();
    expect(data.steps[0].log_excerpt).toBeTruthy();
  });

  it('exposes the triggering parent job via the trigger field for an agent run', async () => {
    const triggerJob = makeJob({
      id: 'agent-1',
      project: 'proj1',
      kind: 'agent:migration',
      startedAt: 990,
      finishedAt: 995,
      exitCode: 0,
      userPrompt: 'do the thing',
    });
    const releaseJob = makeJob({
      id: 'rel-1',
      project: 'proj1',
      kind: 'release',
      startedAt: 1000,
      parentJobId: 'agent-1',
    });
    listJobsMock.mockReturnValue([releaseJob, triggerJob]);

    const res = await GET(req(), params());
    const data = await res.json();
    expect(data.trigger).not.toBeNull();
    expect(data.trigger.job_id).toBe('agent-1');
    expect(data.trigger.kind).toBe('agent:migration');
    expect(data.trigger.label).toBe('agent migration');
    expect(data.trigger.prompt).toBe('do the thing');
  });

  it('labels terminal-run triggers as "terminal run"', async () => {
    const triggerJob = makeJob({
      id: 'run-1',
      project: 'proj1',
      kind: 'run',
      startedAt: 990,
      prompt: 'a long prompt that should still be returned verbatim from the API',
    });
    const releaseJob = makeJob({
      id: 'rel-1',
      project: 'proj1',
      kind: 'release',
      startedAt: 1000,
      parentJobId: 'run-1',
    });
    listJobsMock.mockReturnValue([releaseJob, triggerJob]);

    const res = await GET(req(), params());
    const data = await res.json();
    expect(data.trigger.label).toBe('terminal run');
    expect(data.trigger.prompt).toContain('a long prompt');
  });

  it('returns trigger:null when the release has no parentJobId', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'rel-1', project: 'proj1', kind: 'release', startedAt: 1000 }),
    ]);
    const res = await GET(req(), params());
    const data = await res.json();
    expect(data.trigger).toBeNull();
  });

  it('does not include the trigger job in the steps list (banner-only)', async () => {
    const triggerJob = makeJob({
      id: 'agent-1',
      project: 'proj1',
      kind: 'agent:migration',
      startedAt: 990,
      releaseId: 'rel-1',
    });
    const releaseJob = makeJob({
      id: 'rel-1',
      project: 'proj1',
      kind: 'release',
      startedAt: 1000,
      parentJobId: 'agent-1',
    });
    const testStep = makeJob({ id: 'test-1', project: 'proj1', kind: 'test', startedAt: 1001, releaseId: 'rel-1' });
    listJobsMock.mockReturnValue([releaseJob, triggerJob, testStep]);

    const res = await GET(req(), params());
    const data = await res.json();
    const kinds = data.steps.map((s: { kind: string }) => s.kind);
    expect(kinds).toEqual(['test']);
    expect(kinds).not.toContain('agent:migration');
    expect(kinds).not.toContain('run');
  });

  it('includes fix-push step kind in aggregation', async () => {
    const releaseJob = makeJob({ id: 'rel-1', project: 'proj1', kind: 'release', startedAt: 1000 });
    const pushStep = makeJob({ id: 'push-1', project: 'proj1', kind: 'push', startedAt: 1030, finishedAt: 1031, exitCode: 1, releaseId: 'rel-1' });
    const fixPushStep = makeJob({ id: 'fp-1', project: 'proj1', kind: 'fix-push', startedAt: 1032, finishedAt: 1045, exitCode: 0, releaseId: 'rel-1' });

    listJobsMock.mockReturnValue([releaseJob, pushStep, fixPushStep]);

    const res = await GET(req(), params());
    const data = await res.json();
    const kinds = data.steps.map((s: { kind: string }) => s.kind);
    expect(kinds).toContain('push');
    expect(kinds).toContain('fix-push');
  });
});
