import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS gh_issues_cache (
      project text PRIMARY KEY,
      repo text NOT NULL,
      prs text NOT NULL DEFAULT '[]',
      issues text NOT NULL DEFAULT '[]',
      fetched_at double precision NOT NULL
    )
  `));
}

describe('POST /api/projects/by-project/[projectName]/issues/[number]/close-stale', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ projectName: string; number: string }> }) => Promise<Response>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveGithubRepoMock: ReturnType<typeof vi.fn>;
  let sharedHandle: TestDbHandle;

  function ok(stdout = '') {
    return { exitCode: 0, stdout, stderr: '' };
  }

  function makeRequest(body: unknown) {
    return new NextRequest('http://localhost/api/projects/by-project/proj1/issues/42/close-stale', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function ctx(projectName = 'proj1', number = '42') {
    return { params: Promise.resolve({ projectName, number }) };
  }

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE gh_issues_cache'));

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue(ok());
    resolveGithubRepoMock = vi.fn().mockResolvedValue('owner/repo');

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/gh-status', () => ({
      resolveGithubRepo: resolveGithubRepoMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ projects: {}, logDir: '/tmp' }),
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/issues/[number]/close-stale/route');
    POST = mod.POST;
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 10));
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns 400 when issue number is invalid', async () => {
    const res = await POST(makeRequest({ findings: 'x' }), ctx('proj1', 'abc'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when project is not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const res = await POST(makeRequest({ findings: 'x' }), ctx());
    expect(res.status).toBe(404);
  });

  it('returns 400 when findings is empty', async () => {
    const res = await POST(makeRequest({ findings: '   ' }), ctx());
    expect(res.status).toBe(400);
  });

  it('comments and closes the issue with not_planned by default', async () => {
    await sharedHandle.db.insert(schema.ghIssuesCache)
      .values({
        project: 'proj1',
        repo: 'owner/repo',
        prs: '[]',
        issues: '[{"number":42}]',
        fetchedAt: Date.now() / 1000,
      });
    const res = await POST(makeRequest({ findings: 'No longer reproducible after the fix in #99.' }), ctx());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ status: 'closed', issue: 42, repo: 'owner/repo', reason: 'not_planned', verdict: 'STALE' });

    const calls = execMock.mock.calls;
    expect(calls[0][0]).toBe('gh');
    expect(calls[0][1]).toEqual(expect.arrayContaining(['issue', 'comment', '42', '--repo', 'owner/repo']));
    expect(calls[0][1]).toContain('--body');
    const bodyArgIdx = calls[0][1].indexOf('--body');
    const commentBody = calls[0][1][bodyArgIdx + 1];
    expect(commentBody).toContain('TamTam verdict: STALE');
    expect(commentBody).toContain('No longer reproducible');

    expect(calls[1][1]).toEqual(expect.arrayContaining(['issue', 'close', '42', '--repo', 'owner/repo', '--reason', 'not_planned']));
    const cached = await sharedHandle.db.select().from(schema.ghIssuesCache);
    expect(cached).toHaveLength(0);
  });

  it('uses completed reason when verdict is fixed', async () => {
    const res = await POST(makeRequest({ findings: 'Fixed by #50.', reason: 'fixed' }), ctx());
    expect(res.status).toBe(200);
    const closeCall = execMock.mock.calls[1];
    expect(closeCall[1]).toEqual(expect.arrayContaining(['--reason', 'completed']));
    const data = await res.json();
    expect(data.verdict).toBe('FIXED');
  });

  it('returns 502 when gh comment fails', async () => {
    execMock.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'auth required' });
    const res = await POST(makeRequest({ findings: 'x' }), ctx());
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.detail).toContain('auth required');
  });

  it('returns 502 when gh close fails after comment posted', async () => {
    await sharedHandle.db.insert(schema.ghIssuesCache)
      .values({
        project: 'proj1',
        repo: 'owner/repo',
        prs: '[]',
        issues: '[{"number":42}]',
        fetchedAt: Date.now() / 1000,
      });
    execMock
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'permission denied' });
    const res = await POST(makeRequest({ findings: 'x' }), ctx());
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.detail).toContain('permission denied');
    const cached = await sharedHandle.db.select().from(schema.ghIssuesCache);
    expect(cached).toHaveLength(1);
  });
});
