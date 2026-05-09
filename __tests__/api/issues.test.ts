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
  let loadFileConfigMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    execMock = vi.fn();
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    loadFileConfigMock = vi.fn().mockReturnValue(null);
    getSettingsMock = vi.fn().mockReturnValue({ trusted_github_users: [], github_owner: '' });

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/skills/tamtam-file-config', () => ({ loadFileConfig: loadFileConfigMock }));
    vi.doMock('@/lib/shared/config', async () => {
      const actual = await vi.importActual<typeof import('@/lib/shared/config')>('@/lib/shared/config');
      return {
        ...actual,
        getSettings: getSettingsMock,
      };
    });

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

  it('keeps only globally trusted issue authors when trusted_only=1', async () => {
    getSettingsMock.mockReturnValue({ trusted_github_users: ['trusted-user'], github_owner: '' });
    testDb.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: JSON.stringify([{ number: 11, title: 'PR One' }]),
      issues: JSON.stringify([
        { number: 1, title: 'Keep', author: { login: 'trusted-user' }, labels: [], assignees: [] },
        { number: 2, title: 'Drop', author: { login: 'other-user' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    }).run();

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0].number).toBe(1);
    expect(data.prs).toHaveLength(1);
  });

  it('keeps project safe_users issue authors when trusted_only=1', async () => {
    loadFileConfigMock.mockReturnValue({ safe_users: ['repo-owner'] });
    testDb.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: JSON.stringify([
        { number: 1, title: 'Keep', author: { login: 'repo-owner' }, labels: [], assignees: [] },
        { number: 2, title: 'Drop', author: { login: 'outsider' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    }).run();

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0].author.login).toBe('repo-owner');
  });

  it('unions global trusted_github_users with project safe_users when trusted_only=1', async () => {
    getSettingsMock.mockReturnValue({ trusted_github_users: ['octocat'], github_owner: '' });
    loadFileConfigMock.mockReturnValue({ safe_users: ['repo-owner'] });
    testDb.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: JSON.stringify([
        { number: 1, title: 'Global', author: { login: 'octocat' }, labels: [], assignees: [] },
        { number: 2, title: 'Project', author: { login: 'repo-owner' }, labels: [], assignees: [] },
        { number: 3, title: 'Drop', author: { login: 'outsider' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    }).run();

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.issues.map((issue: { number: number }) => issue.number)).toEqual([1, 2]);
  });

  it('returns no issues when neither global nor project allowlists trust any author', async () => {
    testDb.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: JSON.stringify([
        { number: 1, title: 'Drop', author: { login: 'outsider' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    }).run();

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.issues).toEqual([]);
  });

  it('returns no issues when both allowlists are empty', async () => {
    getSettingsMock.mockReturnValue({ trusted_github_users: [], github_owner: '' });
    loadFileConfigMock.mockReturnValue({ safe_users: [] });
    testDb.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: JSON.stringify([
        { number: 1, title: 'Drop', author: { login: 'outsider' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    }).run();

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.issues).toEqual([]);
  });

  it('matches trusted authors case-insensitively when trusted_only=1', async () => {
    getSettingsMock.mockReturnValue({ trusted_github_users: ['Trusted-User'], github_owner: '' });
    testDb.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: JSON.stringify([
        { number: 1, title: 'Keep', author: { login: 'trusted-user' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    }).run();

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.issues).toHaveLength(1);
  });

  it('leaves prs untouched when trusted_only=1', async () => {
    getSettingsMock.mockReturnValue({ trusted_github_users: [], github_owner: '' });
    testDb.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: JSON.stringify([
        { number: 11, title: 'Visible PR', author: { login: 'outsider' } },
      ]),
      issues: JSON.stringify([
        { number: 1, title: 'Drop', author: { login: 'outsider' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    }).run();

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.prs).toHaveLength(1);
    expect(data.prs[0].title).toBe('Visible PR');
    expect(data.issues).toEqual([]);
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

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
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
      .mockImplementationOnce(() => resp(0, '')) // gh pr merge
      // Post-merge cleanup chain (checkout back to main + pull):
      .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/main\n')) // symbolic-ref
      .mockImplementationOnce(() => resp(0, 'fix/foo\n')) // branch --show-current
      .mockImplementationOnce(() => resp(0, '')) // status --porcelain (clean)
      .mockImplementationOnce(() => resp(0, '')) // checkout main
      .mockImplementationOnce(() => resp(0, '')); // pull --ff-only

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

  it('returns 422 and does NOT fall back to --auto when repo has auto-merge disabled', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(1, '', 'Pull request Auto merge is not allowed for this repository (enablePullRequestAutoMerge)'));

    const res = await POST(makeReq({ prNumber: 9, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.detail).toContain('not allowed');

    const autoCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('--auto'));
    expect(autoCalls).toHaveLength(0);
  });

  it('falls back to --auto when direct merge fails due to pending required checks', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(1, '', 'required status checks have not passed'))
      .mockImplementationOnce(() => resp(0, '')) // retry with --auto succeeds
      .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/main\n')) // symbolic-ref
      .mockImplementationOnce(() => resp(0, 'fix/foo\n')) // branch --show-current
      .mockImplementationOnce(() => resp(0, '')) // status --porcelain
      .mockImplementationOnce(() => resp(0, '')) // checkout
      .mockImplementationOnce(() => resp(0, '')); // pull

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

  // Post-merge cleanup: switch back to the default branch + pull so the
  // working copy is ready for the next task. Stashes dirty state first.
  describe('post-merge cleanup', () => {
    it('switches to default branch (origin/HEAD) and pulls after a clean merge', async () => {
      execMock
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git')) // remote get-url
        .mockImplementationOnce(() => resp(0, '')) // gh pr merge
        .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/main\n')) // symbolic-ref
        .mockImplementationOnce(() => resp(0, 'fix/issue-7\n')) // branch --show-current
        .mockImplementationOnce(() => resp(0, '')) // status --porcelain (clean)
        .mockImplementationOnce(() => resp(0, 'Switched to main')) // checkout main
        .mockImplementationOnce(() => resp(0, 'Already up to date.')); // pull --ff-only

      const res = await POST(makeReq({ prNumber: 42, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('merged');
      expect(data.switchedTo).toBe('main');

      const gitCalls = execMock.mock.calls.filter(([cmd]: any) => cmd === 'git');
      expect(gitCalls.some(([, args]: any) => args[2] === 'symbolic-ref')).toBe(true);
      expect(gitCalls.some(([, args]: any) => args[2] === 'checkout' && args[3] === 'main')).toBe(true);
      expect(gitCalls.some(([, args]: any) => args[2] === 'pull' && args.includes('--ff-only'))).toBe(true);
    });

    it('resolves the default branch from origin/HEAD — honors master', async () => {
      execMock
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(0, ''))
        .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/master\n'))
        .mockImplementationOnce(() => resp(0, 'fix/issue-1\n'))
        .mockImplementationOnce(() => resp(0, ''))
        .mockImplementationOnce(() => resp(0, ''))
        .mockImplementationOnce(() => resp(0, ''));

      const res = await POST(makeReq({ prNumber: 1, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
      const data = await res.json();
      expect(data.switchedTo).toBe('master');

      const checkoutCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'git' && args[2] === 'checkout');
      expect(checkoutCall![1][3]).toBe('master');
    });

    it('stashes uncommitted work before checkout and pops it after pull', async () => {
      execMock
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(0, ''))
        .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/main\n'))
        .mockImplementationOnce(() => resp(0, 'fix/issue-5\n'))
        .mockImplementationOnce(() => resp(0, ' M lib/foo.ts\n')) // dirty
        .mockImplementationOnce(() => resp(0, 'Saved working directory')) // stash push
        .mockImplementationOnce(() => resp(0, '')) // checkout
        .mockImplementationOnce(() => resp(0, '')) // pull
        .mockImplementationOnce(() => resp(0, 'Applied stash@{0}')); // stash pop

      const res = await POST(makeReq({ prNumber: 5, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(200);

      const stashPush = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'git' && args[2] === 'stash' && args[3] === 'push');
      const stashPop = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'git' && args[2] === 'stash' && args[3] === 'pop');
      expect(stashPush).toBeTruthy();
      expect(stashPush![1]).toContain('-u'); // include untracked
      expect(stashPop).toBeTruthy();
    });

    it('skips stash when working tree is clean', async () => {
      execMock
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(0, ''))
        .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/main\n'))
        .mockImplementationOnce(() => resp(0, 'fix/issue-9\n'))
        .mockImplementationOnce(() => resp(0, '')) // clean
        .mockImplementationOnce(() => resp(0, '')) // checkout
        .mockImplementationOnce(() => resp(0, '')); // pull

      await POST(makeReq({ prNumber: 9, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });

      const stashCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args[2] === 'stash');
      expect(stashCalls).toHaveLength(0);
    });

    it('short-circuits to pull when already on the default branch', async () => {
      execMock
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(0, ''))
        .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/main\n'))
        .mockImplementationOnce(() => resp(0, 'main\n')) // already on main
        .mockImplementationOnce(() => resp(0, '')); // pull

      const res = await POST(makeReq({ prNumber: 3, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
      const data = await res.json();
      expect(data.switchedTo).toBe('main');

      const checkoutCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args[2] === 'checkout');
      expect(checkoutCalls).toHaveLength(0);
      const stashCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args[2] === 'stash');
      expect(stashCalls).toHaveLength(0);
    });

    it('restores the stash if checkout fails and returns 207 with switchError', async () => {
      execMock
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(0, ''))
        .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/main\n'))
        .mockImplementationOnce(() => resp(0, 'fix/issue-2\n'))
        .mockImplementationOnce(() => resp(0, ' M lib/bar.ts\n')) // dirty
        .mockImplementationOnce(() => resp(0, 'Saved')) // stash push
        .mockImplementationOnce(() => resp(1, '', 'checkout failed')) // checkout FAIL
        .mockImplementationOnce(() => resp(0, '')); // stash pop on failure path

      const res = await POST(makeReq({ prNumber: 2, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(207); // merged but cleanup failed
      const data = await res.json();
      expect(data.status).toBe('merged_dirty');
      expect(data.switchedTo).toBeNull();
      expect(data.switchError).toContain('checkout failed');

      const stashPop = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'git' && args[2] === 'stash' && args[3] === 'pop');
      expect(stashPop).toBeTruthy();
    });

    it('returns 207 with switchError when cleanup step throws', async () => {
      execMock
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(0, '')) // merge ok
        .mockImplementationOnce(() => Promise.reject(new Error('git fork bomb')));

      const res = await POST(makeReq({ prNumber: 4, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(207);
      const data = await res.json();
      expect(data.status).toBe('merged_dirty');
      expect(data.switchedTo).toBeNull();
      expect(data.switchError).toContain('git fork bomb');
    });

    it('falls back to "main" when origin/HEAD is not set', async () => {
      execMock
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(0, ''))
        .mockImplementationOnce(() => resp(1, '', 'no symbolic ref')) // symbolic-ref fails
        .mockImplementationOnce(() => resp(0, 'fix/other\n'))
        .mockImplementationOnce(() => resp(0, ''))
        .mockImplementationOnce(() => resp(0, ''))
        .mockImplementationOnce(() => resp(0, ''));

      const res = await POST(makeReq({ prNumber: 6, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
      const data = await res.json();
      expect(data.switchedTo).toBe('main');

      const checkoutCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'git' && args[2] === 'checkout');
      expect(checkoutCall![1][3]).toBe('main');
    });

    it('does not run cleanup when merge itself fails', async () => {
      execMock
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(1, '', 'permission denied'));

      const res = await POST(makeReq({ prNumber: 7, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(422);

      const gitCalls = execMock.mock.calls.filter(([cmd]: any) => cmd === 'git');
      // only `git remote get-url` from getGhRepo — no checkout/pull/stash
      expect(gitCalls.every(([, args]: any) => args[0] === 'remote' || args.includes('get-url'))).toBe(true);
    });

    it('does not run cleanup on approve path', async () => {
      execMock
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(0, '')); // gh pr review --approve

      await POST(makeReq({ prNumber: 8, action: 'approve' }), { params: Promise.resolve({ projectName: 'myproj' }) });

      const checkoutCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args[2] === 'checkout');
      expect(checkoutCalls).toHaveLength(0);
    });
  });
});
