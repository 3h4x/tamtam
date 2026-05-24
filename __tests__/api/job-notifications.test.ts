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
    vi.doMock('@/lib/jobs/job-storage', () => ({ markSeen: markSeenMock }));
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
  let probeJobStatusMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    unseenFinishedMock = vi.fn().mockReturnValue([]);
    listJobsMock = vi.fn().mockReturnValue([]);
    jobToDictMock = vi.fn().mockImplementation((j: JobData) => ({ id: j.id, project: j.project }));
    probeJobStatusMock = vi.fn().mockResolvedValue('running');
    vi.doMock('@/lib/jobs/job-storage', () => ({
      unseenFinished: unseenFinishedMock,
      listJobs: listJobsMock,
      jobToDict: jobToDictMock,
      probeJobStatus: probeJobStatusMock,
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
    // Notification route no longer probes — the 30 s background probe sweep
    // owns that work now.
    expect(probeJobStatusMock).not.toHaveBeenCalled();
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

  it('caps notification payloads at the newest 50 while preserving full counts', async () => {
    const unseen = Array.from({ length: 55 }, (_, i) =>
      makeJob({ id: `done-${i}`, finishedAt: 1000 + i, seen: false })
    );
    const running = Array.from({ length: 55 }, (_, i) =>
      makeJob({ id: `run-${i}`, startedAt: 2000 + i, finishedAt: null, exitCode: null })
    );
    unseenFinishedMock.mockReturnValue(unseen);
    listJobsMock.mockReturnValue(running);

    const res = await GET();
    const data = await res.json();

    expect(data.count).toBe(55);
    expect(data.jobs).toHaveLength(50);
    expect(data.jobs[0].id).toBe('done-54');
    expect(data.jobs.at(-1).id).toBe('done-5');
    expect(data.runningCount).toBe(55);
    expect(data.runningJobs).toHaveLength(50);
    expect(data.runningJobs[0].id).toBe('run-54');
    expect(data.runningJobs.at(-1).id).toBe('run-5');
  });

  it('hides unseen failed pipeline jobs once a newer success supersedes them for the same project', async () => {
    const oldFail = makeJob({ id: 'old-fail', kind: 'release', exitCode: 1, finishedAt: 1000, seen: false });
    const newSuccess = makeJob({ id: 'new-pass', kind: 'release', exitCode: 0, finishedAt: 2000, seen: true });
    unseenFinishedMock.mockReturnValue([oldFail]);
    listJobsMock.mockReturnValue([oldFail, newSuccess]);
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(0);
    expect(data.jobs).toEqual([]);
  });

  it('keeps unseen failures when the newer finished job for the project also failed', async () => {
    const oldFail = makeJob({ id: 'old-fail', kind: 'release', exitCode: 1, finishedAt: 1000, seen: false });
    const newFail = makeJob({ id: 'new-fail', kind: 'release', exitCode: 1, finishedAt: 2000, seen: false });
    unseenFinishedMock.mockReturnValue([oldFail, newFail]);
    listJobsMock.mockReturnValue([oldFail, newFail]);
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(2);
  });

  it('does not let a successful agent run silence an older pipeline failure', async () => {
    // Different "domains" — agent runs and pipeline runs are unrelated; a
    // green agent shouldn't claim the pipeline is healthy.
    const oldPipelineFail = makeJob({ id: 'pipe-fail', kind: 'push', exitCode: 1, finishedAt: 1000, seen: false });
    const newAgentSuccess = makeJob({ id: 'agent-ok', kind: 'agent:test', exitCode: 0, finishedAt: 2000, seen: true });
    unseenFinishedMock.mockReturnValue([oldPipelineFail]);
    listJobsMock.mockReturnValue([oldPipelineFail, newAgentSuccess]);
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(1);
  });

  it('does not let a successful fix silence an older unseen pipeline failure', async () => {
    const oldFail = makeJob({ id: 'test-fail', kind: 'test', exitCode: 1, finishedAt: 1000, seen: false });
    const fixSuccess = makeJob({ id: 'fix-ok', kind: 'fix', exitCode: 0, finishedAt: 2000, seen: true });
    unseenFinishedMock.mockReturnValue([oldFail]);
    listJobsMock.mockReturnValue([oldFail, fixSuccess]);
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.jobs[0].id).toBe('test-fail');
  });

  it('does not let a successful push-fix silence an older unseen pipeline failure', async () => {
    // After fix-push collapsed into the generic fix kind, the silencing
    // guard still applies — successful fix steps must not silence prior
    // pipeline failures because the fix needs a follow-up push to verify.
    const oldFail = makeJob({ id: 'push-fail', kind: 'push', exitCode: 1, finishedAt: 1000, seen: false });
    const fixSuccess = makeJob({ id: 'fix-ok', kind: 'fix', parentJobId: 'push-fail', exitCode: 0, finishedAt: 2000, seen: true });
    unseenFinishedMock.mockReturnValue([oldFail]);
    listJobsMock.mockReturnValue([oldFail, fixSuccess]);
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.jobs[0].id).toBe('push-fail');
  });

  it('does not let a successful fix-ci silence an older unseen pipeline failure', async () => {
    const oldFail = makeJob({ id: 'test-fail', kind: 'test', exitCode: 1, finishedAt: 1000, seen: false });
    const fixCiSuccess = makeJob({ id: 'fix-ci-ok', kind: 'fix-ci', exitCode: 0, finishedAt: 2000, seen: true });
    unseenFinishedMock.mockReturnValue([oldFail]);
    listJobsMock.mockReturnValue([oldFail, fixCiSuccess]);
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.jobs[0].id).toBe('test-fail');
  });

  it('suppresses an older unseen fix-ci failure after a later terminal green release succeeds', async () => {
    const oldFixCiFail = makeJob({ id: 'fix-ci-fail', kind: 'fix-ci', exitCode: 1, finishedAt: 1000, seen: false });
    const releaseSuccess = makeJob({ id: 'release-ok', kind: 'release', exitCode: 0, finishedAt: 2000, seen: true });
    unseenFinishedMock.mockReturnValue([oldFixCiFail]);
    listJobsMock.mockReturnValue([oldFixCiFail, releaseSuccess]);
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(0);
    expect(data.jobs).toEqual([]);
  });

  it('suppresses an older unseen failure after a later terminal green release succeeds', async () => {
    const oldFail = makeJob({ id: 'review-fail', kind: 'review', exitCode: 1, finishedAt: 1000, seen: false });
    const fixSuccess = makeJob({ id: 'fix-ok', kind: 'fix', exitCode: 0, finishedAt: 1500, seen: true });
    const releaseSuccess = makeJob({ id: 'release-ok', kind: 'release', exitCode: 0, finishedAt: 2000, seen: true });
    unseenFinishedMock.mockReturnValue([oldFail]);
    listJobsMock.mockReturnValue([oldFail, fixSuccess, releaseSuccess]);
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(0);
    expect(data.jobs).toEqual([]);
  });

  it('does not let a successful mark-dod silence an older unseen pipeline failure', async () => {
    const oldFail = makeJob({ id: 'review-fail', kind: 'review', exitCode: 1, finishedAt: 1000, seen: false });
    const markDodSuccess = makeJob({ id: 'dod-ok', kind: 'mark-dod', exitCode: 0, finishedAt: 2000, seen: true });
    unseenFinishedMock.mockReturnValue([oldFail]);
    listJobsMock.mockReturnValue([oldFail, markDodSuccess]);
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.jobs[0].id).toBe('review-fail');
  });

  it('does not let a successful mark-dod silence an older unseen fix-ci failure', async () => {
    // fix-ci is in PIPELINE_LIKE (so a terminal release success can supersede it)
    // but mark-dod is not a GLOBAL_TERMINAL_SUCCESS_KIND and not the same kind,
    // so it must not clear a fix-ci failure.
    const oldFixCiFail = makeJob({ id: 'fix-ci-fail', kind: 'fix-ci', exitCode: 1, finishedAt: 1000, seen: false });
    const markDodSuccess = makeJob({ id: 'dod-ok', kind: 'mark-dod', exitCode: 0, finishedAt: 2000, seen: true });
    unseenFinishedMock.mockReturnValue([oldFixCiFail]);
    listJobsMock.mockReturnValue([oldFixCiFail, markDodSuccess]);
    const res = await GET();
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.jobs[0].id).toBe('fix-ci-fail');
  });

  it('does not let a newer LGTM review silence an older unseen review failure', async () => {
    const oldReviewFail = makeJob({
      id: 'review-fail',
      kind: 'review',
      exitCode: 1,
      finishedAt: 1000,
      seen: false,
      verdict: 'NEEDS ATTENTION',
    });
    const newReviewPass = makeJob({
      id: 'review-lgtm',
      kind: 'review',
      exitCode: 0,
      finishedAt: 2000,
      seen: true,
      verdict: 'LGTM',
    });
    unseenFinishedMock.mockReturnValue([oldReviewFail]);
    listJobsMock.mockReturnValue([oldReviewFail, newReviewPass]);

    const res = await GET();
    const data = await res.json();

    expect(data.count).toBe(1);
    expect(data.jobs[0].id).toBe('review-fail');
  });

  it('does not let a newer passing test silence an older unseen test failure', async () => {
    const oldTestFail = makeJob({ id: 'test-fail', kind: 'test', exitCode: 1, finishedAt: 1000, seen: false });
    const newTestPass = makeJob({ id: 'test-pass', kind: 'test', exitCode: 0, finishedAt: 2000, seen: true });
    unseenFinishedMock.mockReturnValue([oldTestFail]);
    listJobsMock.mockReturnValue([oldTestFail, newTestPass]);

    const res = await GET();
    const data = await res.json();

    expect(data.count).toBe(1);
    expect(data.jobs[0].id).toBe('test-fail');
  });

  it('does not let a newer successful commit silence an older unseen commit failure', async () => {
    const oldCommitFail = makeJob({ id: 'commit-fail', kind: 'commit', exitCode: 1, finishedAt: 1000, seen: false });
    const newCommitPass = makeJob({ id: 'commit-pass', kind: 'commit', exitCode: 0, finishedAt: 2000, seen: true });
    unseenFinishedMock.mockReturnValue([oldCommitFail]);
    listJobsMock.mockReturnValue([oldCommitFail, newCommitPass]);

    const res = await GET();
    const data = await res.json();

    expect(data.count).toBe(1);
    expect(data.jobs[0].id).toBe('commit-fail');
  });

  it('attaches the originating agent kind to a running release so the bell can render the workflow as one unit', async () => {
    const agent = makeJob({ id: 'agent-improve', kind: 'agent:improve', finishedAt: 800, exitCode: 0, project: 'borged' });
    const release = makeJob({ id: 'rel-1', kind: 'release', finishedAt: null, exitCode: null, project: 'borged', parentJobId: 'agent-improve' });
    listJobsMock.mockReturnValue([agent, release]);

    const res = await GET();
    const data = await res.json();
    const runningRelease = data.runningJobs.find((j: any) => j.id === 'rel-1');
    expect(runningRelease).toBeTruthy();
    expect(runningRelease.parent_kind).toBe('agent:improve');
    expect(runningRelease.parent_job_id).toBe('agent-improve');
  });

  it('omits parent_kind when a running release has no parent agent (manual release)', async () => {
    const release = makeJob({ id: 'rel-manual', kind: 'release', finishedAt: null, exitCode: null, project: 'borged', parentJobId: null });
    listJobsMock.mockReturnValue([release]);

    const res = await GET();
    const data = await res.json();
    const runningRelease = data.runningJobs.find((j: any) => j.id === 'rel-manual');
    expect(runningRelease.parent_kind).toBeNull();
  });

  it('does not attach parent_kind to non-release running jobs', async () => {
    // Even if an agent has a parent_job_id (rare but valid for chained agents),
    // the parent-kind lookup is release-only — we don't want to noise up other
    // kinds' notification payloads.
    const agent = makeJob({ id: 'agent-1', kind: 'agent:improve', finishedAt: null, exitCode: null, project: 'borged', parentJobId: 'something' });
    listJobsMock.mockReturnValue([agent]);

    const res = await GET();
    const data = await res.json();
    expect(data.runningJobs[0].parent_kind).toBeNull();
  });

  it('omits bulky prompt fields from notification jobs', async () => {
    const unseen = makeJob({ id: 'u1', prompt: 'large prompt', userPrompt: 'large user prompt', contextMeta: '{"large":true}' });
    unseenFinishedMock.mockReturnValue([unseen]);
    jobToDictMock.mockReturnValue({
      id: 'u1',
      project: 'proj1',
      prompt: 'large prompt',
      user_prompt: 'large user prompt',
      context_meta: '{"large":true}',
    });
    const res = await GET();
    const data = await res.json();
    expect(data.jobs[0].prompt).toBeNull();
    expect(data.jobs[0].user_prompt).toBeNull();
    expect(data.jobs[0].context_meta).toBeNull();
  });
});

describe('POST /api/jobs/notifications/mark-seen', () => {
  let POST: typeof import('@/app/api/jobs/notifications/mark-seen/route').POST;
  let markAllUnseenFinishedMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    markAllUnseenFinishedMock = vi.fn().mockReturnValue(0);
    vi.doMock('@/lib/jobs/job-storage', () => ({
      markAllUnseenFinished: markAllUnseenFinishedMock,
    }));
    const mod = await import('@/app/api/jobs/notifications/mark-seen/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns ok with the marked count', async () => {
    markAllUnseenFinishedMock.mockReturnValue(2);
    const res = await POST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ status: 'ok', marked: 2 });
  });

  it('invokes the bulk primitive exactly once (no per-row loop)', async () => {
    markAllUnseenFinishedMock.mockReturnValue(5);
    await POST();
    expect(markAllUnseenFinishedMock).toHaveBeenCalledTimes(1);
  });

  it('returns marked=0 when nothing was unseen', async () => {
    markAllUnseenFinishedMock.mockReturnValue(0);
    const res = await POST();
    const data = await res.json();
    expect(data.marked).toBe(0);
  });
});
