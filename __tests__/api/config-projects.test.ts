import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      github TEXT,
      priority TEXT,
      custom_actions TEXT,
      test_command TEXT,
      tests_disabled INTEGER DEFAULT 0,
      review_disabled INTEGER DEFAULT 0,
      test_cron_enabled INTEGER DEFAULT 0,
      test_cron_schedule TEXT,
      auto_commit_enabled INTEGER DEFAULT 0,
      auto_push_enabled INTEGER DEFAULT 0,
      auto_pr_merge_enabled INTEGER DEFAULT 0,
      pr_workflow_enabled INTEGER DEFAULT 0,
      release_after_run INTEGER DEFAULT 0,
      issue_auto_branch INTEGER DEFAULT 1,
      last_push_error TEXT,
      last_push_at REAL,
      review_prompt_addendum TEXT,
      fix_prompt_addendum TEXT,
      website TEXT,
      qa_url TEXT
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function makeGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name);
  mkdirSync(join(repoPath, '.git'), { recursive: true });
  return repoPath;
}

describe('GET /api/config/projects', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let GET: any;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-config-projects-'));
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));

    const mod = await import('@/app/api/config/projects/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty projects when no workspace_path is set', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspace_path).toBe('');
    expect(data.projects).toEqual([]);
  });

  it('returns empty projects when workspace_path does not exist', async () => {
    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: '/nonexistent/workspace' })
      .run();

    const res = await GET();
    const data = await res.json();
    expect(data.workspace_path).toBe('/nonexistent/workspace');
    expect(data.projects).toEqual([]);
  });

  it('discovers git repos in workspace', async () => {
    makeGitRepo(tempDir, 'repo-a');
    makeGitRepo(tempDir, 'repo-b');

    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: tempDir })
      .run();

    const res = await GET();
    const data = await res.json();
    expect(data.projects).toHaveLength(2);
    const names = data.projects.map((p: any) => p.name);
    expect(names).toContain('repo-a');
    expect(names).toContain('repo-b');
  });

  it('returns projects sorted alphabetically by name', async () => {
    makeGitRepo(tempDir, 'zebra');
    makeGitRepo(tempDir, 'alpha');
    makeGitRepo(tempDir, 'middle');

    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: tempDir })
      .run();

    const res = await GET();
    const data = await res.json();
    const names = data.projects.map((p: any) => p.name);
    expect(names).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('skips node_modules directory', async () => {
    makeGitRepo(tempDir, 'real-repo');
    mkdirSync(join(tempDir, 'node_modules', '.git'), { recursive: true });

    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: tempDir })
      .run();

    const res = await GET();
    const data = await res.json();
    const names = data.projects.map((p: any) => p.name);
    expect(names).toContain('real-repo');
    expect(names).not.toContain('node_modules');
  });

  it('skips hidden directories (starting with .)', async () => {
    makeGitRepo(tempDir, 'visible-repo');
    mkdirSync(join(tempDir, '.hidden', '.git'), { recursive: true });

    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: tempDir })
      .run();

    const res = await GET();
    const data = await res.json();
    const names = data.projects.map((p: any) => p.name);
    expect(names).toContain('visible-repo');
    expect(names).not.toContain('.hidden');
  });

  it('skips dist, build, .next directories', async () => {
    makeGitRepo(tempDir, 'valid-repo');
    for (const skip of ['dist', 'build', '.next']) {
      mkdirSync(join(tempDir, skip, '.git'), { recursive: true });
    }

    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: tempDir })
      .run();

    const res = await GET();
    const data = await res.json();
    const names = data.projects.map((p: any) => p.name);
    expect(names).toEqual(['valid-repo']);
  });

  it('ignores directories without .git', async () => {
    mkdirSync(join(tempDir, 'not-a-repo'));
    makeGitRepo(tempDir, 'is-a-repo');

    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: tempDir })
      .run();

    const res = await GET();
    const data = await res.json();
    const names = data.projects.map((p: any) => p.name);
    expect(names).toEqual(['is-a-repo']);
  });

  it('merges discovered repos with saved project state', async () => {
    makeGitRepo(tempDir, 'my-repo');

    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: tempDir })
      .run();
    testDb.db.insert(schema.projects)
      .values({ name: 'my-repo', path: join(tempDir, 'my-repo'), enabled: true, github: 'owner/my-repo', priority: 'high' })
      .run();

    const res = await GET();
    const data = await res.json();
    expect(data.projects).toHaveLength(1);
    const proj = data.projects[0];
    expect(proj.name).toBe('my-repo');
    expect(proj.enabled).toBe(true);
    expect(proj.github).toBe('owner/my-repo');
    expect(proj.priority).toBe('high');
  });

  it('returns enabled=false for repos without saved state', async () => {
    makeGitRepo(tempDir, 'new-repo');

    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: tempDir })
      .run();

    const res = await GET();
    const data = await res.json();
    expect(data.projects[0].enabled).toBe(false);
    expect(data.projects[0].github).toBeNull();
  });

  it('includes custom_actions from saved project', async () => {
    makeGitRepo(tempDir, 'repo-with-actions');

    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: tempDir })
      .run();
    testDb.db.insert(schema.projects)
      .values({
        name: 'repo-with-actions',
        path: join(tempDir, 'repo-with-actions'),
        enabled: false,
        customActions: JSON.stringify([{ name: 'deploy', command: './deploy.sh' }]),
      })
      .run();

    const res = await GET();
    const data = await res.json();
    expect(data.projects[0].custom_actions).toEqual([{ name: 'deploy', command: './deploy.sh' }]);
  });

  it('returns empty custom_actions when none saved', async () => {
    makeGitRepo(tempDir, 'plain-repo');

    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: tempDir })
      .run();

    const res = await GET();
    const data = await res.json();
    expect(data.projects[0].custom_actions).toEqual([]);
  });

  it('handles malformed custom_actions JSON gracefully', async () => {
    makeGitRepo(tempDir, 'bad-actions-repo');

    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: tempDir })
      .run();
    testDb.db.insert(schema.projects)
      .values({
        name: 'bad-actions-repo',
        path: join(tempDir, 'bad-actions-repo'),
        enabled: false,
        customActions: 'not-valid-json',
      })
      .run();

    const res = await GET();
    const data = await res.json();
    expect(data.projects[0].custom_actions).toEqual([]);
  });

  it('includes correct path in project data', async () => {
    const repoPath = makeGitRepo(tempDir, 'path-test-repo');

    testDb.db.insert(schema.settings)
      .values({ key: 'workspace_path', value: tempDir })
      .run();

    const res = await GET();
    const data = await res.json();
    expect(data.projects[0].path).toBe(repoPath);
  });
});

describe('PATCH /api/config/projects', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let PATCH: any;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));

    const mod = await import('@/app/api/config/projects/route');
    PATCH = mod.PATCH;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 400 when projects is not an array', async () => {
    const req = new NextRequest('http://localhost/api/config/projects', {
      method: 'PATCH',
      body: JSON.stringify({ projects: 'not-an-array' }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('array');
  });

  it('returns ok for empty projects array', async () => {
    const req = new NextRequest('http://localhost/api/config/projects', {
      method: 'PATCH',
      body: JSON.stringify({ projects: [] }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('inserts new project into database', async () => {
    const req = new NextRequest('http://localhost/api/config/projects', {
      method: 'PATCH',
      body: JSON.stringify({
        projects: [
          { name: 'my-project', path: '/home/user/my-project', enabled: true, github: 'owner/my-project' },
        ],
      }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);

    const saved = testDb.db.select().from(schema.projects).all();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('my-project');
    expect(saved[0].path).toBe('/home/user/my-project');
    expect(saved[0].enabled).toBe(true);
    expect(saved[0].github).toBe('owner/my-project');
  });

  it('upserts existing project', async () => {
    testDb.db.insert(schema.projects)
      .values({ name: 'existing', path: '/old/path', enabled: false })
      .run();

    const req = new NextRequest('http://localhost/api/config/projects', {
      method: 'PATCH',
      body: JSON.stringify({
        projects: [{ name: 'existing', path: '/new/path', enabled: true }],
      }),
    });
    await PATCH(req);

    const saved = testDb.db.select().from(schema.projects).all();
    expect(saved).toHaveLength(1);
    expect(saved[0].path).toBe('/new/path');
    expect(saved[0].enabled).toBe(true);
  });

  it('stores custom_actions as JSON', async () => {
    const actions = [{ name: 'deploy', command: './deploy.sh', color: 'green' }];

    const req = new NextRequest('http://localhost/api/config/projects', {
      method: 'PATCH',
      body: JSON.stringify({
        projects: [
          { name: 'proj', path: '/path', enabled: true, custom_actions: actions },
        ],
      }),
    });
    await PATCH(req);

    const saved = testDb.db.select().from(schema.projects).all();
    expect(JSON.parse(saved[0].customActions!)).toEqual(actions);
  });

  it('handles multiple projects in one request', async () => {
    const req = new NextRequest('http://localhost/api/config/projects', {
      method: 'PATCH',
      body: JSON.stringify({
        projects: [
          { name: 'proj-a', path: '/a', enabled: true },
          { name: 'proj-b', path: '/b', enabled: false },
          { name: 'proj-c', path: '/c', enabled: true, priority: 'high' },
        ],
      }),
    });
    await PATCH(req);

    const saved = testDb.db.select().from(schema.projects).all();
    expect(saved).toHaveLength(3);
  });

  it('sets github to null when not provided', async () => {
    const req = new NextRequest('http://localhost/api/config/projects', {
      method: 'PATCH',
      body: JSON.stringify({
        projects: [{ name: 'proj', path: '/path', enabled: false }],
      }),
    });
    await PATCH(req);

    const saved = testDb.db.select().from(schema.projects).all();
    expect(saved[0].github).toBeNull();
  });

});
