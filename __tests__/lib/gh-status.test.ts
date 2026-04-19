import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS gh_status (
      project TEXT PRIMARY KEY,
      release_tag TEXT,
      ci TEXT,
      ci_failed_url TEXT,
      head_sha TEXT,
      local_head_sha TEXT,
      fetched_at TEXT NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('gh-status invalidateProject', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let invalidateProject: typeof import('@/lib/gh-status').invalidateProject;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shell', () => ({ exec: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }) }));

    const mod = await import('@/lib/gh-status');
    invalidateProject = mod.invalidateProject;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('creates a new entry with ci=in_progress when project has no existing entry', () => {
    invalidateProject('new-project');

    const row = testDb.db
      .select()
      .from(schema.ghStatus)
      .get();

    expect(row).toBeTruthy();
    expect(row!.project).toBe('new-project');
    expect(row!.ci).toBe('in_progress');
    expect(row!.ciFailedUrl).toBeNull();
    expect(row!.fetchedAt).toBe('1970-01-01T00:00:00Z');
  });

  it('updates existing entry to ci=in_progress and clears ciFailedUrl', () => {
    testDb.db.insert(schema.ghStatus).values({
      project: 'my-project',
      releaseTag: 'v1.0.0',
      ci: 'failure',
      ciFailedUrl: 'https://github.com/actions/1',
      headSha: 'abc123',
      localHeadSha: 'abc123',
      fetchedAt: '2024-01-01T00:00:00Z',
    }).run();

    invalidateProject('my-project');

    const row = testDb.db.select().from(schema.ghStatus).get();
    expect(row!.ci).toBe('in_progress');
    expect(row!.ciFailedUrl).toBeNull();
    expect(row!.fetchedAt).toBe('1970-01-01T00:00:00Z');
  });

  it('preserves release tag when invalidating', () => {
    testDb.db.insert(schema.ghStatus).values({
      project: 'my-project',
      releaseTag: 'v2.5.0',
      ci: 'success',
      ciFailedUrl: null,
      headSha: 'def456',
      localHeadSha: 'def456',
      fetchedAt: '2024-06-01T00:00:00Z',
    }).run();

    invalidateProject('my-project');

    const row = testDb.db.select().from(schema.ghStatus).get();
    expect(row!.releaseTag).toBe('v2.5.0');
  });

  it('can invalidate multiple different projects', () => {
    invalidateProject('project-a');
    invalidateProject('project-b');

    const rows = testDb.db.select().from(schema.ghStatus).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.project).sort()).toEqual(['project-a', 'project-b']);
    expect(rows.every((r) => r.ci === 'in_progress')).toBe(true);
  });

  it('sets fetchedAt to epoch to force refresh', () => {
    invalidateProject('proj');
    const row = testDb.db.select().from(schema.ghStatus).get();
    expect(row!.fetchedAt).toBe('1970-01-01T00:00:00Z');
  });
});

describe('gh-status ghRepo auto-detection via git remote', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let execMock: ReturnType<typeof vi.fn>;
  let ghStatusLookup: typeof import('@/lib/gh-status').ghStatusLookup;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    execMock = vi.fn();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));

    const mod = await import('@/lib/gh-status');
    ghStatusLookup = mod.ghStatusLookup;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.GITHUB_OWNER;
  });

  it('uses cfg.github directly without calling git remote get-url', async () => {
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

    await ghStatusLookup({
      p1: { project: 'myproject', github: 'myorg/myrepo', path: '/some/path' },
    });

    const gitRemoteCalls = execMock.mock.calls.filter(
      (c: any[]) => c[0] === 'git' && c[1]?.includes('get-url')
    );
    expect(gitRemoteCalls).toHaveLength(0);
  });

  it('parses SSH remote URL git@github.com:org/repo.git to org/repo', async () => {
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.some((a: string) => a === 'get-url')) {
        return { exitCode: 0, stdout: 'git@github.com:my-org/my-repo.git\n', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    });

    await ghStatusLookup({ p1: { project: 'my-repo', path: '/fake/path' } });

    const ghApiCalls = execMock.mock.calls.filter(
      (c: any[]) => c[0] === 'gh' && c[1]?.[0] === 'api'
    );
    if (ghApiCalls.length > 0) {
      const repoArg = (ghApiCalls[0][1] as string[]).find((a) => a.includes('my-org/my-repo'));
      expect(repoArg).toBeTruthy();
    }
  });

  it('parses HTTPS remote URL https://github.com/org/repo.git to org/repo', async () => {
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.some((a: string) => a === 'get-url')) {
        return { exitCode: 0, stdout: 'https://github.com/other-org/cool-project.git\n', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    });

    await ghStatusLookup({ p1: { project: 'cool-project', path: '/repo/path' } });

    const ghApiCalls = execMock.mock.calls.filter(
      (c: any[]) => c[0] === 'gh' && c[1]?.[0] === 'api'
    );
    if (ghApiCalls.length > 0) {
      const repoArg = (ghApiCalls[0][1] as string[]).find((a) => a.includes('other-org/cool-project'));
      expect(repoArg).toBeTruthy();
    }
  });

  it('calls git remote get-url with the configured path', async () => {
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

    await ghStatusLookup({ p1: { project: 'myproj', path: '/workspace/myproj' } });

    const gitCalls = execMock.mock.calls.filter(
      (c: any[]) => c[0] === 'git' && c[1]?.includes('get-url')
    );
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(gitCalls[0][1]).toContain('/workspace/myproj');
  });

  it('falls back to GITHUB_OWNER/projName when git remote fails', async () => {
    process.env.GITHUB_OWNER = 'fallback-owner';
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

    await ghStatusLookup({ p1: { project: 'myproj', path: '/some/path' } });

    const ghApiCalls = execMock.mock.calls.filter(
      (c: any[]) => c[0] === 'gh' && c[1]?.[0] === 'api'
    );
    if (ghApiCalls.length > 0) {
      const repoArg = (ghApiCalls[0][1] as string[]).find((a) => a.includes('fallback-owner/myproj'));
      expect(repoArg).toBeTruthy();
    }
  });

  it('falls back to projName/projName when no GITHUB_OWNER and git remote fails', async () => {
    delete process.env.GITHUB_OWNER;
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

    await ghStatusLookup({ p1: { project: 'standalone', path: '/p' } });

    const ghApiCalls = execMock.mock.calls.filter(
      (c: any[]) => c[0] === 'gh' && c[1]?.[0] === 'api'
    );
    if (ghApiCalls.length > 0) {
      const repoArg = (ghApiCalls[0][1] as string[]).find((a) => a.includes('standalone/standalone'));
      expect(repoArg).toBeTruthy();
    }
  });
});
