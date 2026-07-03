import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql, eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import { clearTrustedUsersCache } from '@/lib/shared/untrusted';
import { createJob, getJob, updateJob } from '@/lib/jobs/job-storage';

let sharedHandle: TestDbHandle;

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  resolveProjectPath: vi.fn(),
  clearProjectDataCache: vi.fn(),
  loadFileConfig: vi.fn(),
  getSettings: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: mocks.resolveProjectPath,
  clearProjectDataCache: mocks.clearProjectDataCache,
}));
vi.mock('@/lib/shared/shell', () => ({ exec: mocks.exec }));
vi.mock('@/lib/db', () => ({
  get db() {
    return mocks.getDb();
  },
  schema,
}));
vi.mock('@/lib/skills/tamtam-file-config', () => ({
  loadFileConfig: mocks.loadFileConfig,
  loadFileConfigWithSource: (projectPath: string) => {
    const config = mocks.loadFileConfig(projectPath);
    return {
      config,
      source: {
        kind: 'pinned-ref',
        ref: 'test',
        relPath: '.tamtam/config.yml',
        fingerprint: JSON.stringify(config),
      },
    };
  },
  fingerprintWorkingTreeConfig: () => 'test',
}));
vi.mock('@/lib/shared/config', () => ({
  getSettings: mocks.getSettings,
}));

// Import route once at module scope — the mocks above are hoisted before this.
import { GET, POST } from '@/app/api/projects/by-project/[projectName]/issues/route';

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

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyDdl(sharedHandle);
  mocks.getDb.mockReturnValue(sharedHandle.db);
});

afterAll(async () => {
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

function resp(exitCode: number, stdout = '', stderr = '') {
  return Promise.resolve({ exitCode, stdout, stderr });
}

describe('GET /api/projects/by-project/[projectName]/issues', () => {
  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE gh_issues_cache'));
    mocks.exec.mockReset();
    mocks.resolveProjectPath.mockReset().mockReturnValue('/path/to/proj');
    mocks.clearProjectDataCache.mockReset();
    mocks.loadFileConfig.mockReset().mockReturnValue(null);
    mocks.getSettings.mockReset().mockReturnValue({ trusted_github_users: [], github_owner: '' });
    mocks.getDb.mockReturnValue(sharedHandle.db);
    clearTrustedUsersCache();
  });

  it('returns 404 when project not found', async () => {
    mocks.resolveProjectPath.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/issues');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns cached data when cache is fresh', async () => {
    const now = Date.now() / 1000;
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: JSON.stringify([{ number: 1, title: 'PR One' }]),
      issues: JSON.stringify([{ number: 2, title: 'Bug One' }]),
      fetchedAt: now - 10,
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cached).toBe(true);
    expect(data.repo).toBe('owner/myproj');
    expect(data.prs).toHaveLength(1);
    expect(data.prs[0].title).toBe('PR One');
    expect(data.issues[0].title).toBe('Bug One');
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('returns cached summary data with trusted issue filtering', async () => {
    mocks.getSettings.mockReturnValue({ trusted_github_users: ['trusted-user'], github_owner: '' });
    const now = Date.now() / 1000;
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: JSON.stringify([
        { number: 11, title: 'Visible PR', headRefName: 'feat/open-pr' },
      ]),
      issues: JSON.stringify([
        { number: 1, title: 'Keep', author: { login: 'trusted-user' }, labels: [], assignees: [] },
        { number: 2, title: 'Drop', author: { login: 'outsider' }, labels: [], assignees: [] },
      ]),
      fetchedAt: now - 10,
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?summary=1&trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      repo: 'owner/myproj',
      prCount: 1,
      issueCount: 1,
      openPrBranches: [{ branch: 'feat/open-pr', number: 11 }],
      error: null,
      cached: true,
    });
    expect(data.cachedAt).toBe(now - 10);
    expect(data.prs).toBeUndefined();
    expect(data.issues).toBeUndefined();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('fetches from gh when cache is stale', async () => {
    const staleTime = Date.now() / 1000 - 400;
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: '[]',
      fetchedAt: staleTime,
    });

    mocks.exec
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

  it('folds per-row context/gates into the full payload (no per-row fetch)', async () => {
    mocks.getSettings.mockReturnValue({ trusted_github_users: [], github_owner: '' });
    // Issue #3 carries an acceptance-criteria checklist in its body; the PR
    // links to it. DoD must be derived from that already-fetched body — no
    // extra `gh issue view` round-trip (only 3 exec calls: remote + pr/issue list).
    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, JSON.stringify([
        { number: 9, title: 'Fix it', body: 'Closes #3', headRefName: 'feat/x' },
      ])))
      .mockImplementationOnce(() => resp(0, JSON.stringify([
        { number: 3, title: 'Issue three', body: '- [x] done\n- [ ] todo' },
      ])));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?full=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    // hasContext folded onto every issue (false — no jobs in the test cache).
    expect(data.issues[0].hasContext).toBe(false);
    // gates folded onto the PR, DoD sourced from issue #3's body.
    expect(data.prs[0].gates).toMatchObject({ issueNumber: 3, dod: 'warn', dodSummary: '1/2 DoD' });
    // Exactly 3 exec calls — no per-PR gh issue view fan-out.
    expect(mocks.exec).toHaveBeenCalledTimes(3);
  });

  it('returns live summary data with trusted issue filtering', async () => {
    mocks.getSettings.mockReturnValue({ trusted_github_users: ['trusted-user'], github_owner: '' });
    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, JSON.stringify([
        { number: 7, title: 'Fresh PR', headRefName: 'feat/live-pr' },
      ])))
      .mockImplementationOnce(() => resp(0, JSON.stringify([
        { number: 3, title: 'Fresh Issue', author: { login: 'trusted-user' }, labels: [], assignees: [] },
        { number: 4, title: 'Untrusted Issue', author: { login: 'outsider' }, labels: [], assignees: [] },
      ])));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?summary=1&trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      repo: 'owner/myproj',
      prCount: 1,
      issueCount: 1,
      openPrBranches: [{ branch: 'feat/live-pr', number: 7 }],
      error: null,
      cached: false,
    });
    expect(typeof data.cachedAt).toBe('number');
    expect(data.prs).toBeUndefined();
    expect(data.issues).toBeUndefined();
  });

  it('bypasses cache when refresh=1', async () => {
    const now = Date.now() / 1000;
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: JSON.stringify([{ number: 1, title: 'Old PR' }]),
      issues: '[]',
      fetchedAt: now - 10,
    });

    mocks.exec
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
    mocks.exec
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
    mocks.exec
      .mockImplementationOnce(() => resp(0, 'git@github.com:acme/coolrepo.git'))
      .mockImplementationOnce(() => resp(0, '[]'))
      .mockImplementationOnce(() => resp(0, '[]'));

    const req = new NextRequest('http://localhost/api/projects/by-project/coolrepo/issues');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'coolrepo' }) });
    const data = await res.json();
    expect(data.repo).toBe('acme/coolrepo');
  });

  it('writes fresh results to cache on success', async () => {
    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, JSON.stringify([{ number: 1 }])))
      .mockImplementationOnce(() => resp(0, '[]'));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues');
    await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });

    const rows = await sharedHandle.db.select().from(schema.ghIssuesCache)
      .where(eq(schema.ghIssuesCache.project, 'myproj'));
    const row = rows[0];
    expect(row).toBeTruthy();
    expect(JSON.parse(row!.prs)).toHaveLength(1);
  });

  it('keeps only globally trusted issue authors when trusted_only=1', async () => {
    mocks.getSettings.mockReturnValue({ trusted_github_users: ['trusted-user'], github_owner: '' });
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: JSON.stringify([{ number: 11, title: 'PR One' }]),
      issues: JSON.stringify([
        { number: 1, title: 'Keep', author: { login: 'trusted-user' }, labels: [], assignees: [] },
        { number: 2, title: 'Drop', author: { login: 'other-user' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0].number).toBe(1);
    expect(data.prs).toHaveLength(1);
  });

  it('keeps project safe_users issue authors when trusted_only=1', async () => {
    mocks.loadFileConfig.mockReturnValue({ safe_users: ['repo-owner'] });
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: JSON.stringify([
        { number: 1, title: 'Keep', author: { login: 'repo-owner' }, labels: [], assignees: [] },
        { number: 2, title: 'Drop', author: { login: 'outsider' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0].number).toBe(1);
  });

  it('unions global trusted_github_users with project safe_users when trusted_only=1', async () => {
    mocks.getSettings.mockReturnValue({ trusted_github_users: ['octocat'], github_owner: '' });
    mocks.loadFileConfig.mockReturnValue({ safe_users: ['repo-owner'] });
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: JSON.stringify([
        { number: 1, title: 'Global', author: { login: 'octocat' }, labels: [], assignees: [] },
        { number: 2, title: 'Project', author: { login: 'repo-owner' }, labels: [], assignees: [] },
        { number: 3, title: 'Drop', author: { login: 'outsider' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.issues.map((issue: { number: number }) => issue.number)).toEqual([1, 2]);
  });

  it('returns no issues when neither global nor project allowlists trust any author', async () => {
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: JSON.stringify([
        { number: 1, title: 'Drop', author: { login: 'outsider' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.issues).toEqual([]);
  });

  it('returns no issues when both allowlists are empty', async () => {
    mocks.getSettings.mockReturnValue({ trusted_github_users: [], github_owner: '' });
    mocks.loadFileConfig.mockReturnValue({ safe_users: [] });
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: JSON.stringify([
        { number: 1, title: 'Drop', author: { login: 'outsider' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.issues).toEqual([]);
  });

  it('matches trusted authors case-insensitively when trusted_only=1', async () => {
    mocks.getSettings.mockReturnValue({ trusted_github_users: ['Trusted-User'], github_owner: '' });
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: JSON.stringify([
        { number: 1, title: 'Keep', author: { login: 'trusted-user' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.issues).toHaveLength(1);
  });

  it('leaves prs untouched when trusted_only=1', async () => {
    mocks.getSettings.mockReturnValue({ trusted_github_users: [], github_owner: '' });
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: JSON.stringify([
        { number: 11, title: 'Visible PR', author: { login: 'outsider' } },
      ]),
      issues: JSON.stringify([
        { number: 1, title: 'Drop', author: { login: 'outsider' }, labels: [], assignees: [] },
      ]),
      fetchedAt: Date.now() / 1000,
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?trusted_only=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.prs).toHaveLength(1);
    expect(data.prs[0].title).toBe('Visible PR');
    expect(data.issues).toEqual([]);
  });

  it('strips body and heavy fields by default (slim)', async () => {
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: JSON.stringify([{ number: 5, title: 'My PR', headRefName: 'feat/x', isDraft: false, labels: [{ id: '1', name: 'bug', description: '', color: 'red' }], author: { login: 'me' }, body: 'big pr body' }]),
      issues: JSON.stringify([{ number: 3, title: 'My Issue', labels: [{ id: '2', name: 'enhancement', description: '', color: 'blue' }], author: { login: 'me' }, body: 'long issue body', assignees: [] }]),
      fetchedAt: Date.now() / 1000,
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    const issue = data.issues[0];
    expect(issue.number).toBe(3);
    expect(issue.title).toBe('My Issue');
    expect(issue.labels).toEqual(['enhancement']);
    expect(issue.body).toBeUndefined();
    expect(issue.author).toBe('me');
    const pr = data.prs[0];
    expect(pr.number).toBe(5);
    expect(pr.labels).toEqual(['bug']);
    expect(pr.branch).toBe('feat/x');
    expect(pr.body).toBeUndefined();
    expect(pr.author).toBe('me');
  });

  it('returns full issue data when full=1', async () => {
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: JSON.stringify([{ number: 3, title: 'My Issue', labels: [], author: { login: 'me' }, body: 'long issue body', assignees: [] }]),
      fetchedAt: Date.now() / 1000,
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/issues?full=1');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    const issue = data.issues[0];
    expect(issue.body).toBe('long issue body');
    expect(issue.author).toEqual({ login: 'me' });
  });
});

describe('POST /api/projects/by-project/[projectName]/issues', () => {
  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE gh_issues_cache'));
    mocks.exec.mockReset();
    mocks.resolveProjectPath.mockReset().mockReturnValue('/path/to/proj');
    mocks.clearProjectDataCache.mockReset();
    mocks.loadFileConfig.mockReset().mockReturnValue(null);
    mocks.getSettings.mockReset().mockReturnValue({ trusted_github_users: [], github_owner: '' });
    mocks.getDb.mockReturnValue(sharedHandle.db);
    clearTrustedUsersCache();
  });

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
    mocks.resolveProjectPath.mockReturnValue(null);
    const res = await POST(makeReq({ prNumber: 1 }), { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('merges a PR successfully and returns status merged', async () => {
    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git')) // git remote get-url
      .mockImplementationOnce(() => resp(0, '')) // gh pr merge
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

  it('resolves an outstanding pr-wait HITL when the PR is merged (stamps prWaitReason=merged)', async () => {
    // A pr-wait that deferred auto-merge to a human (risky_diff) raises a
    // `pr_needs_manual_merge` inbox card. Merging that PR here IS the
    // resolution, so it must clear the HITL. Without stamping the job, the
    // card lingers forever: this handler wipes the gh-issues cache on merge,
    // and the inbox derivation fails open (surfaces) when it can't confirm the
    // PR is closed — so the merge that resolves the HITL is the one action
    // that can never clear it.
    const seeded = createJob(
      'myproj',
      'pr-wait',
      0,
      '/tmp/pr-wait.log',
      undefined,
      JSON.stringify({ prNumber: 4242, prWaitReason: 'risky_diff', riskyFiles: ['ecosystem.config.cjs'] }),
    );
    seeded.finishedAt = seeded.startedAt + 1;
    seeded.exitCode = 1;
    updateJob(seeded);

    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git')) // git remote get-url
      .mockImplementationOnce(() => resp(0, '')) // gh pr merge
      .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/main\n')) // symbolic-ref
      .mockImplementationOnce(() => resp(0, 'main\n')) // branch --show-current (already on main)
      .mockImplementationOnce(() => resp(0, '')); // pull --ff-only

    const res = await POST(makeReq({ prNumber: 4242, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);

    const after = getJob(seeded.id);
    expect(after).not.toBeNull();
    const meta = JSON.parse(after!.contextMeta!);
    expect(meta.prWaitReason).toBe('merged');
  });

  it('does NOT resolve the pr-wait HITL when the merge only enabled auto-merge (checks pending)', async () => {
    // `gh pr merge --auto` exits 0 by merely ENABLING auto-merge — the PR is
    // not merged yet and may never merge if a required check later fails.
    // Clearing the HITL here would strand an unmerged PR with no inbox card
    // (a silent stop). The card must survive until the PR actually lands.
    const seeded = createJob(
      'myproj',
      'pr-wait',
      0,
      '/tmp/pr-wait-auto.log',
      undefined,
      JSON.stringify({ prNumber: 4343, prWaitReason: 'risky_diff' }),
    );
    seeded.finishedAt = seeded.startedAt + 1;
    seeded.exitCode = 1;
    updateJob(seeded);

    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git')) // git remote get-url
      .mockImplementationOnce(() => resp(1, '', 'required status checks have not passed')) // direct merge fails
      .mockImplementationOnce(() => resp(0, '')) // --auto enable succeeds (NOT merged)
      .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/main\n')) // symbolic-ref
      .mockImplementationOnce(() => resp(0, 'main\n')) // branch --show-current
      .mockImplementationOnce(() => resp(0, '')); // pull --ff-only

    const res = await POST(makeReq({ prNumber: 4343, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);

    const after = getJob(seeded.id);
    expect(JSON.parse(after!.contextMeta!).prWaitReason).toBe('risky_diff');
  });

  it('calls gh pr merge with correct --squash flag', async () => {
    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, ''));

    await POST(makeReq({ prNumber: 7, action: 'merge', mergeMethod: 'squash' }), { params: Promise.resolve({ projectName: 'myproj' }) });

    const mergeCalls = mocks.exec.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('merge'));
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0][1]).toContain('--squash');
  });

  it('returns 422 and does NOT fall back to --auto when repo has auto-merge disabled', async () => {
    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(1, '', 'Pull request Auto merge is not allowed for this repository (enablePullRequestAutoMerge)'));

    const res = await POST(makeReq({ prNumber: 9, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.detail).toContain('not allowed');

    const autoCalls = mocks.exec.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('--auto'));
    expect(autoCalls).toHaveLength(0);
  });

  it('falls back to --auto when direct merge fails due to pending required checks', async () => {
    mocks.exec
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

    const autoCalls = mocks.exec.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('--auto'));
    expect(autoCalls).toHaveLength(1);
  });

  it('returns 422 when merge fails without auto-merge pattern', async () => {
    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(1, '', 'permission denied'));

    const res = await POST(makeReq({ prNumber: 1, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.detail).toBe('permission denied');
  });

  it('approves a PR successfully', async () => {
    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, ''));

    const res = await POST(makeReq({ prNumber: 3, action: 'approve' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('approved');
    expect(data.pr).toBe(3);

    const approveCalls = mocks.exec.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('--approve'));
    expect(approveCalls).toHaveLength(1);
  });

  it('returns 422 when approve fails', async () => {
    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(1, '', 'cannot review your own PR'));

    const res = await POST(makeReq({ prNumber: 5, action: 'approve' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.detail).toBe('cannot review your own PR');
  });

  it('invalidates cache after successful merge', async () => {
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: '[]',
      fetchedAt: Date.now() / 1000,
    });

    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, ''));

    await POST(makeReq({ prNumber: 1, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });

    const rows = await sharedHandle.db.select().from(schema.ghIssuesCache)
      .where(eq(schema.ghIssuesCache.project, 'myproj'));
    expect(rows.length).toBe(0);
  });

  it('invalidates cache after successful approve', async () => {
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'myproj',
      repo: 'owner/myproj',
      prs: '[]',
      issues: '[]',
      fetchedAt: Date.now() / 1000,
    });

    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(0, ''));

    await POST(makeReq({ prNumber: 2, action: 'approve' }), { params: Promise.resolve({ projectName: 'myproj' }) });

    const rows = await sharedHandle.db.select().from(schema.ghIssuesCache)
      .where(eq(schema.ghIssuesCache.project, 'myproj'));
    expect(rows.length).toBe(0);
  });

  it('does not fall back to --auto when merge fails with unrelated error', async () => {
    mocks.exec
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
      .mockImplementationOnce(() => resp(1, '', 'branch does not exist'));

    const res = await POST(makeReq({ prNumber: 1, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(422);

    const autoCalls = mocks.exec.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('--auto'));
    expect(autoCalls).toHaveLength(0);
  });

  // Post-merge cleanup: switch back to the default branch + pull so the
  // working copy is ready for the next task. Stashes dirty state first.
  describe('post-merge cleanup', () => {
    it('switches to default branch (origin/HEAD) and pulls after a clean merge', async () => {
      mocks.exec
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

      const gitCalls = mocks.exec.mock.calls.filter(([cmd]: any) => cmd === 'git');
      expect(gitCalls.some(([, args]: any) => args[2] === 'symbolic-ref')).toBe(true);
      expect(gitCalls.some(([, args]: any) => args[2] === 'checkout' && args[3] === 'main')).toBe(true);
      expect(gitCalls.some(([, args]: any) => args[2] === 'pull' && args.includes('--ff-only'))).toBe(true);
    });

    it('resolves the default branch from origin/HEAD — honors master', async () => {
      mocks.exec
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

      const checkoutCall = mocks.exec.mock.calls.find(([cmd, args]: any) => cmd === 'git' && args[2] === 'checkout');
      expect(checkoutCall![1][3]).toBe('master');
    });

    it('stashes uncommitted work before checkout and pops it after pull', async () => {
      mocks.exec
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

      const stashPush = mocks.exec.mock.calls.find(([cmd, args]: any) => cmd === 'git' && args[2] === 'stash' && args[3] === 'push');
      const stashPop = mocks.exec.mock.calls.find(([cmd, args]: any) => cmd === 'git' && args[2] === 'stash' && args[3] === 'pop');
      expect(stashPush).toBeTruthy();
      expect(stashPush![1]).toContain('-u'); // include untracked
      expect(stashPop).toBeTruthy();
    });

    it('skips stash when working tree is clean', async () => {
      mocks.exec
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(0, ''))
        .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/main\n'))
        .mockImplementationOnce(() => resp(0, 'fix/issue-9\n'))
        .mockImplementationOnce(() => resp(0, '')) // clean
        .mockImplementationOnce(() => resp(0, '')) // checkout
        .mockImplementationOnce(() => resp(0, '')); // pull

      await POST(makeReq({ prNumber: 9, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });

      const stashCalls = mocks.exec.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args[2] === 'stash');
      expect(stashCalls).toHaveLength(0);
    });

    it('short-circuits to pull when already on the default branch', async () => {
      mocks.exec
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(0, ''))
        .mockImplementationOnce(() => resp(0, 'refs/remotes/origin/main\n'))
        .mockImplementationOnce(() => resp(0, 'main\n')) // already on main
        .mockImplementationOnce(() => resp(0, '')); // pull

      const res = await POST(makeReq({ prNumber: 3, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
      const data = await res.json();
      expect(data.switchedTo).toBe('main');

      const checkoutCalls = mocks.exec.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args[2] === 'checkout');
      expect(checkoutCalls).toHaveLength(0);
      const stashCalls = mocks.exec.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args[2] === 'stash');
      expect(stashCalls).toHaveLength(0);
    });

    it('restores the stash if checkout fails and returns 207 with switchError', async () => {
      mocks.exec
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

      const stashPop = mocks.exec.mock.calls.find(([cmd, args]: any) => cmd === 'git' && args[2] === 'stash' && args[3] === 'pop');
      expect(stashPop).toBeTruthy();
    });

    it('returns 207 with switchError when cleanup step throws', async () => {
      mocks.exec
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
      mocks.exec
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

      const checkoutCall = mocks.exec.mock.calls.find(([cmd, args]: any) => cmd === 'git' && args[2] === 'checkout');
      expect(checkoutCall![1][3]).toBe('main');
    });

    it('does not run cleanup when merge itself fails', async () => {
      mocks.exec
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(1, '', 'permission denied'));

      const res = await POST(makeReq({ prNumber: 7, action: 'merge' }), { params: Promise.resolve({ projectName: 'myproj' }) });
      expect(res.status).toBe(422);

      const gitCalls = mocks.exec.mock.calls.filter(([cmd]: any) => cmd === 'git');
      // only `git remote get-url` from getGhRepo — no checkout/pull/stash
      expect(gitCalls.every(([, args]: any) => args[0] === 'remote' || args.includes('get-url'))).toBe(true);
    });

    it('does not run cleanup on approve path', async () => {
      mocks.exec
        .mockImplementationOnce(() => resp(0, 'https://github.com/owner/myproj.git'))
        .mockImplementationOnce(() => resp(0, '')); // gh pr review --approve

      await POST(makeReq({ prNumber: 8, action: 'approve' }), { params: Promise.resolve({ projectName: 'myproj' }) });

      const checkoutCalls = mocks.exec.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args[2] === 'checkout');
      expect(checkoutCalls).toHaveLength(0);
    });
  });
});
