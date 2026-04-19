import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS gh_issues_cache (
      project TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      prs TEXT NOT NULL DEFAULT '[]',
      issues TEXT NOT NULL DEFAULT '[]',
      fetched_at REAL NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('GET /api/projects/by-project/[projectName]/issues', () => {
  let GET: any;
  let POST: any;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    execMock = vi.fn();
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/issues/route');
    GET = mod.GET;
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    testDb.sqlite.close();
  });

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/issues');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns cached data when cache is fresh', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: JSON.stringify([{ number: 1, title: 'PR One' }]),
      issues: JSON.stringify([{ number: 2, title: 'Bug One' }]),
      fetchedAt: now - 10, // 10 seconds ago, within 5-min TTL
    }).run();

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cached).toBe(true);
    expect(data.repo).toBe('owner/myproj');
    expect(data.prs).toHaveLength(1);
    expect(data.prs[0].title).toBe('PR One');
    expect(data.issues[0].title).toBe('Bug One');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('fetches from gh when cache is stale', async () => {
    const staleTime = Date.now() / 1000 - 400; // 400s ago, past 300s TTL
    testDb.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: '[]',
      fetchedAt: staleTime,
    }).run();

    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, JSON.stringify([{ number: 5, title: 'Fresh PR' }])))
      .mockImplementationOnce(() => resp(0, JSON.stringify([{ number: 3, title: 'Fresh Issue' }])));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cached).toBe(false);
    expect(data.prs[0].title).toBe('Fresh PR');
    expect(data.issues[0].title).toBe('Fresh Issue');
  });

  it('bypasses cache when refresh=1', async () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: JSON.stringify([{ number: 1, title: 'Old PR' }]),
      issues: '[]',
      fetchedAt: now - 10,
    }).run();

    execMock
      .mockImplementationOnce(() => resp(0, 'git@github.com:owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, JSON.stringify([{ number: 7, title: 'New PR' }])))
      .mockImplementationOnce(() => resp(0, '[]'));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?refresh=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cached).toBe(false);
    expect(data.prs[0].title).toBe('New PR');
  });

  it('returns gh error in response when gh pr list fails', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(1, '', 'authentication required'))
      .mockImplementationOnce(() => resp(0, '[]'));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error).toBe('authentication required');
  });

  it('parses SSH remote URL to owner/repo format', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'git@github.com:acme/coolrepo.git'))
      .mockImplementationOnce(() => resp(0, '[]'))
      .mockImplementationOnce(() => resp(0, '[]'));

    const req = new NextRequest('http://localhost/api/projects/by-project/coolrepo/issues');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'coolrepo' }) });
    const data = await res.json();
    expect(data.repo).toBe('acme/coolrepo');
  });

  it('writes fresh results to cache on success', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, JSON.stringify([{ number: 1 }])))
      .mockImplementationOnce(() => resp(0, '[]'));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues');
    await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });

    const row = testDb.db.select().from(schema.ghIssuesCache)
      .where(require('drizzle-orm').eq(schema.ghIssuesCache.project, 'myproj'))
      .get();
    expect(row).toBeTruthy();
    expect(JSON.parse(row!.prs)).toHaveLength(1);
  });
});

describe('POST /api/projects/by-project/[projectName]/issues', () => {
  let POST: any;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    execMock = vi.fn();
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/issues/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    testDb.sqlite.close();
  });

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  function makeReq(body: object) {
    return new NextRequest('http://localhost/api/projects/by-project/myproj/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns 400 when prNumber is missing', async () => {
    const res = await POST(makeReq({}), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('prNumber required');
  });

  it('returns 400 when action is invalid', async () => {
    const res = await POST(makeReq({ prNumber: 1, action: 'close' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('action must be');
  });

  it('returns 400 when mergeMethod is invalid for merge action', async () => {
    const res = await POST(makeReq({ prNumber: 1, action: 'merge', mergeMethod: 'fast-forward' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('mergeMethod must be');
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const res = await POST(makeReq({ prNumber: 1 }), { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('merges a PR successfully and returns status merged', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git')) // git remote get-url
      .mockImplementationOnce(() => resp(0, '')); // gh pr merge

    const res = await POST(makeReq({ prNumber: 42, action: 'merge', mergeMethod: 'squash' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('merged');
    expect(data.pr).toBe(42);
  });

  it('calls gh pr merge with correct --squash flag', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, ''));

    await POST(makeReq({ prNumber: 7, action: 'merge', mergeMethod: 'squash' }), { params: Promise.resolve({ projectName: 'myproj' }) });

    const mergeCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('merge'));
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0][1]).toContain('--squash');
  });

  it('falls back to --auto when direct merge fails with "auto merge" error', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(1, '', 'Pull request Auto merge is not allowed'))
      .mockImplementationOnce(() => resp(0, '')); // retry with --auto succeeds

    const res = await POST(makeReq({ prNumber: 9, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('merged');

    const autoCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('--auto'));
    expect(autoCalls).toHaveLength(1);
  });

  it('returns 422 when merge fails without auto-merge pattern', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(1, '', 'permission denied'));

    const res = await POST(makeReq({ prNumber: 1, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.detail).toBe('permission denied');
  });

  it('approves a PR successfully', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, ''));

    const res = await POST(makeReq({ prNumber: 3, action: 'approve' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('approved');
    expect(data.pr).toBe(3);

    const approveCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('--approve'));
    expect(approveCalls).toHaveLength(1);
  });

  it('returns 422 when approve fails', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(1, '', 'cannot review your own PR'));

    const res = await POST(makeReq({ prNumber: 5, action: 'approve' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.detail).toBe('cannot review your own PR');
  });

  it('invalidates cache after successful merge', async () => {
    testDb.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: '[]',
      fetchedAt: Date.now() / 1000,
    }).run();

    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, ''));

    await POST(makeReq({ prNumber: 1, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });

    const row = testDb.db.select().from(schema.ghIssuesCache)
      .where(require('drizzle-orm').eq(schema.ghIssuesCache.project, 'myproj'))
      .get();
    expect(row).toBeUndefined();
  });

  it('invalidates cache after successful approve', async () => {
    testDb.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: '[]',
      fetchedAt: Date.now() / 1000,
    }).run();

    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, ''));

    await POST(makeReq({ prNumber: 2, action: 'approve' }), { params: Promise.resolve({ projectName: 'myproj' }) });

    const row = testDb.db.select().from(schema.ghIssuesCache)
      .where(require('drizzle-orm').eq(schema.ghIssuesCache.project, 'myproj'))
      .get();
    expect(row).toBeUndefined();
  });

  it('does not fall back to --auto when merge fails with unrelated error', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(1, '', 'branch does not exist'));

    const res = await POST(makeReq({ prNumber: 1, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(422);

    const autoCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('--auto'));
    expect(autoCalls).toHaveLength(0);
  });
});
