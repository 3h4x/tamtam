import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('GET /api/projects/by-project/{projectName}/continue-issue', () => {
  let GET: any;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let readLogMock: ReturnType<typeof vi.fn>;

  function makeJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'job-1',
      project: 'myproj',
      kind: 'run',
      startedAt: 1000,
      finishedAt: 2000,
      exitCode: 0,
      sessionId: 'ses-abc',
      ghIssueNumber: 7,
      ghIssueRepo: 'owner/repo',
      ...overrides,
    };
  }

  function makeMarkDodJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'dod-1',
      project: 'myproj',
      kind: 'mark-dod',
      startedAt: 1500,
      finishedAt: 2500,
      exitCode: 0,
      sessionId: null,
      ...overrides,
    };
  }

  function req(url: string) {
    return new Request(url);
  }

  function params(projectName: string) {
    return { params: Promise.resolve({ projectName }) };
  }

  beforeEach(async () => {
    vi.resetModules();
    listJobsMock = vi.fn().mockReturnValue([]);
    readLogMock = vi.fn().mockReturnValue('');
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      readLog: readLogMock,
    }));
    const mod = await import(
      '@/app/api/projects/by-project/[projectName]/continue-issue/route'
    );
    GET = mod.GET;
  });

  afterEach(() => vi.resetModules());

  it('returns 400 when issue_number is missing', async () => {
    const res = await GET(req('http://localhost/api/projects/by-project/myproj/continue-issue'), params('myproj'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('issue_number');
  });

  it('returns 400 when issue_number is zero', async () => {
    const res = await GET(req('http://localhost?issue_number=0'), params('myproj'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when issue_number is negative', async () => {
    const res = await GET(req('http://localhost?issue_number=-5'), params('myproj'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when issue_number is non-numeric', async () => {
    const res = await GET(req('http://localhost?issue_number=abc'), params('myproj'));
    expect(res.status).toBe(400);
  });

  it('returns 200 with generic fallback prompt when no prior jobs exist', async () => {
    listJobsMock.mockReturnValue([]);
    const res = await GET(req('http://localhost?issue_number=7'), params('myproj'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessionId).toBeNull();
    expect(data.unverifiedCount).toBe(0);
    expect(data.hasContext).toBe(false);
    expect(data.prompt).toContain('issue #7');
  });

  it('returns sessionId from the most recent run job tagged with the issue', async () => {
    listJobsMock.mockReturnValue([makeJob({ sessionId: 'ses-xyz', ghIssueNumber: 7 })]);
    const res = await GET(req('http://localhost?issue_number=7'), params('myproj'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessionId).toBe('ses-xyz');
    expect(data.hasContext).toBe(true);
  });

  it('ignores run jobs from other issues when finding sessionId', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ sessionId: 'ses-other', ghIssueNumber: 99 }),
    ]);
    const res = await GET(req('http://localhost?issue_number=7'), params('myproj'));
    const data = await res.json();
    expect(data.sessionId).toBeNull();
    expect(data.hasContext).toBe(false);
  });

  it('picks the most recent run job when multiple exist for the same issue', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ id: 'old', sessionId: 'ses-old', ghIssueNumber: 7, startedAt: 500 }),
      makeJob({ id: 'new', sessionId: 'ses-new', ghIssueNumber: 7, startedAt: 9000 }),
    ]);
    const res = await GET(req('http://localhost?issue_number=7'), params('myproj'));
    const data = await res.json();
    expect(data.sessionId).toBe('ses-new');
  });

  it('ignores run jobs with no sessionId', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ sessionId: null, ghIssueNumber: 7 }),
    ]);
    const res = await GET(req('http://localhost?issue_number=7'), params('myproj'));
    const data = await res.json();
    expect(data.sessionId).toBeNull();
    expect(data.hasContext).toBe(false);
  });

  it('parses unverified items from mark-dod log and includes them in the prompt', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ ghIssueNumber: 7 }),
      makeMarkDodJob(),
    ]);
    readLogMock.mockReturnValue(
      '# [unverified] 2.1 Add unit tests\n# evidence: no test files found\n# [unverified] 3.1 Update docs\n'
    );
    const res = await GET(req('http://localhost?issue_number=7'), params('myproj'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.unverifiedCount).toBe(2);
    expect(data.prompt).toContain('Add unit tests');
    expect(data.prompt).toContain('Update docs');
    expect(data.prompt).toContain('no test files found');
  });

  it('includes evidence note in prompt when evidence is present', async () => {
    listJobsMock.mockReturnValue([makeJob({ ghIssueNumber: 7 }), makeMarkDodJob()]);
    readLogMock.mockReturnValue('# [unverified] Implement auth\n# evidence: missing lib/auth.ts\n');
    const res = await GET(req('http://localhost?issue_number=7'), params('myproj'));
    const data = await res.json();
    expect(data.prompt).toContain('missing lib/auth.ts');
  });

  it('falls back to generic prompt when mark-dod log has no unverified lines', async () => {
    listJobsMock.mockReturnValue([makeJob({ ghIssueNumber: 7 }), makeMarkDodJob()]);
    readLogMock.mockReturnValue('All criteria verified!\n');
    const res = await GET(req('http://localhost?issue_number=7'), params('myproj'));
    const data = await res.json();
    expect(data.unverifiedCount).toBe(0);
    expect(data.prompt).toContain('issue #7');
  });

  it('returns unverifiedCount=0 and fallback prompt when readLog throws', async () => {
    listJobsMock.mockReturnValue([makeJob({ ghIssueNumber: 7 }), makeMarkDodJob()]);
    readLogMock.mockImplementation(() => { throw new Error('file missing'); });
    const res = await GET(req('http://localhost?issue_number=7'), params('myproj'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.unverifiedCount).toBe(0);
  });

  it('accepts fix kind jobs as valid resume targets', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ kind: 'fix', sessionId: 'ses-fix', ghIssueNumber: 7 }),
    ]);
    const res = await GET(req('http://localhost?issue_number=7'), params('myproj'));
    const data = await res.json();
    expect(data.sessionId).toBe('ses-fix');
    expect(data.hasContext).toBe(true);
  });
});
