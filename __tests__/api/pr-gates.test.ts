import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/job-storage';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1',
    project: 'myproj',
    kind: 'test',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: Date.now() / 1000,
    finishedAt: Date.now() / 1000,
    exitCode: 0,
    seen: false,
    ...overrides,
  };
}

describe('GET /api/projects/by-project/[projectName]/pr-gates', () => {
  let GET: (req: Request, ctx: { params: Promise<{ projectName: string }> }) => Promise<Response>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let getVerdictMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let extractCriteriaMock: ReturnType<typeof vi.fn>;

  function makeRequest(searchParams: Record<string, string> = {}) {
    const url = new URL('http://localhost/api/projects/by-project/myproj/pr-gates');
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
    return new Request(url.toString());
  }

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/project');
    listJobsMock = vi.fn().mockReturnValue([]);
    getVerdictMock = vi.fn().mockReturnValue(null);
    execMock = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    extractCriteriaMock = vi.fn().mockReturnValue([]);

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      getVerdict: getVerdictMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/pipeline/start-mark-dod', () => ({
      extractCriteria: extractCriteriaMock,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/pr-gates/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const res = await GET(makeRequest(), { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('project not found');
  });

  it('returns all none when no issue context', async () => {
    const res = await GET(makeRequest(), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.issueNumber).toBeNull();
    expect(data.tests).toBe('none');
    expect(data.review).toBe('none');
    expect(data.dod).toBe('none');
  });

  it('parses issue number from issue query param', async () => {
    const res = await GET(makeRequest({ issue: '42' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.issueNumber).toBe(42);
  });

  it('parses issue number from PR body via body param', async () => {
    const res = await GET(makeRequest({ body: 'Fixes #7 in this PR' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.issueNumber).toBe(7);
  });

  it('reports tests=pass when test job exited 0', async () => {
    listJobsMock.mockReturnValue([makeJob({ kind: 'test', exitCode: 0, ghIssueNumber: 5 })]);
    const res = await GET(makeRequest({ issue: '5' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    const data = await res.json();
    expect(data.tests).toBe('pass');
  });

  it('reports tests=fail when test job exited non-zero', async () => {
    listJobsMock.mockReturnValue([makeJob({ kind: 'test', exitCode: 1, ghIssueNumber: 5 })]);
    const res = await GET(makeRequest({ issue: '5' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    const data = await res.json();
    expect(data.tests).toBe('fail');
  });

  it('reports review=pass when verdict is LGTM', async () => {
    listJobsMock.mockReturnValue([makeJob({ kind: 'review', exitCode: 0, ghIssueNumber: 5 })]);
    getVerdictMock.mockReturnValue('LGTM');
    const res = await GET(makeRequest({ issue: '5' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    const data = await res.json();
    expect(data.review).toBe('pass');
  });

  it('reports review=warn when verdict is NEEDS ATTENTION', async () => {
    listJobsMock.mockReturnValue([makeJob({ kind: 'review', exitCode: 0, ghIssueNumber: 5 })]);
    getVerdictMock.mockReturnValue('NEEDS ATTENTION');
    const res = await GET(makeRequest({ issue: '5' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    const data = await res.json();
    expect(data.review).toBe('warn');
  });

  it('reports review=fail when verdict is DO NOT SHIP', async () => {
    listJobsMock.mockReturnValue([makeJob({ kind: 'review', exitCode: 0, ghIssueNumber: 5 })]);
    getVerdictMock.mockReturnValue('DO NOT SHIP');
    const res = await GET(makeRequest({ issue: '5' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    const data = await res.json();
    expect(data.review).toBe('fail');
  });

  it('reports review=fail when review job exited non-zero', async () => {
    listJobsMock.mockReturnValue([makeJob({ kind: 'review', exitCode: 2, ghIssueNumber: 5 })]);
    const res = await GET(makeRequest({ issue: '5' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    const data = await res.json();
    expect(data.review).toBe('fail');
  });

  it('falls back to any recent job when no issue-linked job exists', async () => {
    listJobsMock.mockReturnValue([makeJob({ kind: 'test', exitCode: 0, ghIssueNumber: null })]);
    const res = await GET(makeRequest({ issue: '99' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    const data = await res.json();
    expect(data.tests).toBe('pass');
  });

  it('skips DoD check when repo param is not provided', async () => {
    listJobsMock.mockReturnValue([]);
    const res = await GET(makeRequest({ issue: '1' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    const data = await res.json();
    expect(data.dod).toBe('none');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('reports dod=pass when all criteria are checked', async () => {
    execMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ body: '- [x] criterion 1\n- [x] criterion 2' }),
      stderr: '',
    });
    extractCriteriaMock.mockReturnValue([]);
    const res = await GET(makeRequest({ issue: '1', repo: 'owner/repo' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    const data = await res.json();
    expect(data.dod).toBe('pass');
    expect(data.dodSummary).toBe('2/2 DoD');
  });

  it('reports dod=warn when some criteria are unchecked', async () => {
    execMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ body: '- [x] done\n- [ ] pending' }),
      stderr: '',
    });
    extractCriteriaMock.mockReturnValue(['pending']);
    const res = await GET(makeRequest({ issue: '1', repo: 'owner/repo' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    const data = await res.json();
    expect(data.dod).toBe('warn');
    expect(data.dodSummary).toBe('1/2 DoD');
  });

  it('reports dod=none when gh issue view fails', async () => {
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not found' });
    const res = await GET(makeRequest({ issue: '1', repo: 'owner/repo' }), {
      params: Promise.resolve({ projectName: 'myproj' }),
    });
    const data = await res.json();
    expect(data.dod).toBe('none');
  });
});
