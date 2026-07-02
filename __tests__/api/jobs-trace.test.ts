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

describe('GET /api/jobs/{jobId}/trace', () => {
  let GET: (req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) => Promise<Response>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let getVerdictMock: ReturnType<typeof vi.fn>;
  let readLogMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    listJobsMock = vi.fn().mockReturnValue([]);
    getVerdictMock = vi.fn().mockReturnValue(null);
    readLogMock = vi.fn().mockReturnValue('');

    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      getVerdict: getVerdictMock,
      readLog: readLogMock,
    }));

    const mod = await import('@/app/api/jobs/[jobId]/trace/route');
    GET = mod.GET as typeof GET;
  });

  afterEach(() => vi.resetModules());

  function req() {
    return new NextRequest('http://localhost/api/jobs/job-1/trace');
  }
  function params(jobId = 'job-1') {
    return { params: Promise.resolve({ jobId }) };
  }

  it('returns 404 for an unknown job id', async () => {
    listJobsMock.mockReturnValue([]);
    const res = await GET(req(), params());
    expect(res.status).toBe(404);
  });

  it('returns the unit, its report, usage and context for a plain agent run', async () => {
    listJobsMock.mockReturnValue([
      makeJob({
        id: 'agent-1',
        kind: 'agent:cruncher',
        startedAt: 1000,
        finishedAt: 1200,
        exitCode: 0,
        workSummary: 'Implemented X',
        modifiedFiles: '["a.ts","b.ts"]',
        linesAdded: 40,
        linesRemoved: 5,
        inputTokens: 1000,
        outputTokens: 200,
        costUsd: 1.23,
        model: 'gpt-5.5',
        runScore: 88,
        skillIds: '["frontend"]',
      }),
    ]);
    const res = await GET(req(), params('agent-1'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job_id).toBe('agent-1');
    expect(data.status).toBe('done');
    expect(data.workSummary).toBe('Implemented X');
    expect(data.files.files).toEqual(['a.ts', 'b.ts']);
    expect(data.files.linesAdded).toBe(40);
    expect(data.usage.costUsd).toBe(1.23);
    expect(data.usage.model).toBe('gpt-5.5');
    expect(data.context.runScore).toBe(88);
    expect(data.context.skills).toEqual(['frontend']);
    expect(data.steps).toEqual([]);
    expect(data.release_id).toBeNull();
  });

  it('includes the pipeline steps of a release the unit triggered', async () => {
    const agent = makeJob({ id: 'agent-1', kind: 'agent:cruncher', startedAt: 1000, finishedAt: 1005, exitCode: 0 });
    const release = makeJob({ id: 'rel-1', kind: 'release', startedAt: 1006, parentJobId: 'agent-1' });
    const test = makeJob({ id: 'test-1', kind: 'test', startedAt: 1007, finishedAt: 1010, exitCode: 0, releaseId: 'rel-1' });
    const review = makeJob({ id: 'review-1', kind: 'review', startedAt: 1011, finishedAt: 1020, exitCode: 0, releaseId: 'rel-1' });
    listJobsMock.mockReturnValue([agent, release, test, review]);
    getVerdictMock.mockImplementation((j: JobData) => (j.id === 'review-1' ? 'LGTM' : null));
    readLogMock.mockReturnValue('step log');

    const res = await GET(req(), params('agent-1'));
    const data = await res.json();
    expect(data.release_id).toBe('rel-1');
    expect(data.steps.map((s: { kind: string }) => s.kind)).toEqual(['test', 'review']);
    expect(data.steps[1].verdict).toBe('LGTM');
    expect(data.steps[0].log_excerpt).toBe('step log');
  });

  it('resolves the trigger (parent) job with a friendly label', async () => {
    const trigger = makeJob({ id: 'agent-1', kind: 'agent:migration', startedAt: 990, userPrompt: 'do the thing' });
    const release = makeJob({ id: 'rel-1', kind: 'release', startedAt: 1000, parentJobId: 'agent-1' });
    listJobsMock.mockReturnValue([release, trigger]);
    const res = await GET(req(), params('rel-1'));
    const data = await res.json();
    expect(data.trigger.job_id).toBe('agent-1');
    expect(data.trigger.label).toBe('agent migration');
    expect(data.trigger.prompt).toBe('do the thing');
  });

  it('includes mark-dod-verify in a release timeline (display-only)', async () => {
    const release = makeJob({ id: 'rel-1', kind: 'release', startedAt: 1000 });
    const dod = makeJob({ id: 'dod-1', kind: 'mark-dod', startedAt: 1010, finishedAt: 1012, exitCode: 0, releaseId: 'rel-1' });
    const verify = makeJob({ id: 'v-1', kind: 'mark-dod-verify', startedAt: 1013, finishedAt: 1030, exitCode: 0, releaseId: 'rel-1' });
    listJobsMock.mockReturnValue([release, dod, verify]);
    const res = await GET(req(), params('rel-1'));
    const data = await res.json();
    expect(data.steps.map((s: { kind: string }) => s.kind)).toEqual(['mark-dod', 'mark-dod-verify']);
  });

  it('surfaces a release stop reason from context_meta', async () => {
    listJobsMock.mockReturnValue([
      makeJob({
        id: 'rel-1',
        kind: 'release',
        startedAt: 1000,
        finishedAt: 1001,
        exitCode: 1,
        contextMeta: JSON.stringify({ releaseStopReason: 'release first-step failed: refusing to run tests on non-default branch' }),
      }),
    ]);
    const res = await GET(req(), params('rel-1'));
    const data = await res.json();
    expect(data.context.releaseStopReason).toContain('refusing to run tests');
  });
});
