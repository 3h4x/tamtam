import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
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
      fix_prompt_addendum TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      pid INTEGER NOT NULL,
      log_path TEXT,
      started_at REAL NOT NULL,
      finished_at REAL,
      exit_code INTEGER,
      seen INTEGER DEFAULT 0,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_create_tokens INTEGER,
      session_id TEXT,
      user_prompt TEXT,
      context_meta TEXT,
      parent_job_id TEXT,
      gh_issue_number INTEGER,
      gh_issue_repo TEXT,
      gh_issue_title TEXT,
      log_pruned INTEGER DEFAULT 0,
      verdict TEXT,
      cost_usd REAL,
      model TEXT,
      release_id TEXT,
      aborted_at REAL,
      prompt_bytes INTEGER,
      work_summary TEXT,
      modified_files TEXT,
      provider TEXT
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('action API (GET and PUT)', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let GET: any;
  let PUT: any;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({
      db: testDb.db,
      schema,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/action/route');
    GET = mod.GET;
    PUT = mod.PUT;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('GET /projects/by-project/[projectName]/action', () => {
    it('returns empty actions when project does not exist', async () => {
      const request = new NextRequest('http://localhost/api/projects/by-project/unknown/action');
      const response = await GET(request, {
        params: Promise.resolve({ projectName: 'unknown' }),
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.actions).toEqual([]);
    });

    it('returns empty actions when project has no custom actions', async () => {
      testDb.db
        .insert(schema.projects)
        .values({ name: 'proj1', path: '/path/to/proj1', customActions: null })
        .run();

      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action');
      const response = await GET(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      const data = await response.json();
      expect(data.actions).toEqual([]);
    });

    it('returns project custom actions', async () => {
      const actions = [
        { name: 'deploy', command: 'npm run deploy', color: 'green' },
        { name: 'test', command: 'npm test' },
      ];
      testDb.db
        .insert(schema.projects)
        .values({
          name: 'proj1',
          path: '/path/to/proj1',
          customActions: JSON.stringify(actions),
        })
        .run();

      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action');
      const response = await GET(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      const data = await response.json();
      expect(data.actions).toHaveLength(2);
      expect(data.actions[0].name).toBe('deploy');
      expect(data.actions[0].command).toBe('npm run deploy');
      expect(data.actions[0].color).toBe('green');
    });

    it('returns empty actions when custom_actions is invalid JSON', async () => {
      testDb.db
        .insert(schema.projects)
        .values({
          name: 'proj1',
          path: '/path/to/proj1',
          customActions: 'not-valid-json',
        })
        .run();

      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action');
      const response = await GET(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      const data = await response.json();
      expect(data.actions).toEqual([]);
    });

  });

  describe('PUT /projects/by-project/[projectName]/action', () => {
    beforeEach(() => {
      testDb.db
        .insert(schema.projects)
        .values({ name: 'proj1', path: '/path/to/proj1' })
        .run();
    });

    it('validates that actions is an array', async () => {
      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions: 'not-an-array' }),
      });
      const response = await PUT(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.detail).toContain('array');
    });

    it('validates each action has name and command', async () => {
      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions: [{ name: 'deploy' }] }), // missing command
      });
      const response = await PUT(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.detail).toContain('command');
    });

    it('validates each action has a name', async () => {
      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions: [{ command: 'npm run x' }] }), // missing name
      });
      const response = await PUT(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      expect(response.status).toBe(400);
    });

    it('saves valid actions and returns them', async () => {
      const actions = [
        { name: 'deploy', command: 'npm run deploy', color: 'green' },
        { name: 'build', command: 'npm run build' },
      ];
      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions }),
      });
      const response = await PUT(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.actions).toEqual(actions);
    });

    it('accepts empty actions array', async () => {
      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions: [] }),
      });
      const response = await PUT(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.actions).toEqual([]);
    });

    it('persists actions to database', async () => {
      const actions = [{ name: 'deploy', command: 'npm run deploy' }];
      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions }),
      });
      await PUT(request, { params: Promise.resolve({ projectName: 'proj1' }) });

      const getRequest = new NextRequest(
        'http://localhost/api/projects/by-project/proj1/action'
      );
      const getResponse = await GET(getRequest, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      const data = await getResponse.json();
      expect(data.actions).toHaveLength(1);
      expect(data.actions[0].name).toBe('deploy');
    });
  });
});

// .tamtam/config.yml is the version-controlled team contract; PUT must mirror
// custom_actions to it, GET must prefer it over the DB, and an explicitly
// empty file array must clear teammates' DB-stored actions.
describe('action API — file mirroring (.tamtam/config.yml)', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let tmpDir: string;
  let GET: any;
  let PUT: any;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    tmpDir = join(tmpdir(), `tamtam-action-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));

    testDb.db
      .insert(schema.projects)
      .values({ name: 'proj1', path: tmpDir, enabled: true })
      .run();

    const mod = await import('@/app/api/projects/by-project/[projectName]/action/route');
    GET = mod.GET;
    PUT = mod.PUT;
  });

  afterEach(() => {
    vi.resetModules();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PUT writes custom_actions to .tamtam/config.yml', async () => {
    const actions = [
      { name: 'deploy', command: './deploy.sh', color: 'green' },
      { name: 'lint', command: 'pnpm lint' },
    ];
    const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
      method: 'PUT',
      body: JSON.stringify({ actions }),
    });
    const response = await PUT(request, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(response.status).toBe(200);

    const cfgPath = join(tmpDir, '.tamtam', 'config.yml');
    expect(existsSync(cfgPath)).toBe(true);
    const content = readFileSync(cfgPath, 'utf-8');
    expect(content).toContain('actions:');
    expect(content).toContain('deploy');
    expect(content).toContain('./deploy.sh');
    expect(content).toContain('green');
    expect(content).toContain('pnpm lint');
  });

  it('GET prefers .tamtam/config.yml over the DB column', async () => {
    // DB has one set of actions ...
    testDb.sqlite
      .prepare('UPDATE projects SET custom_actions = ? WHERE name = ?')
      .run(JSON.stringify([{ name: 'db-only', command: 'echo db' }]), 'proj1');

    // ... and the file has a different set.
    mkdirSync(join(tmpDir, '.tamtam'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.tamtam', 'config.yml'),
      'actions:\n  custom_actions:\n    - name: from-file\n      command: echo file\n'
    );

    const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action');
    const response = await GET(request, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await response.json();
    expect(data.actions).toEqual([{ name: 'from-file', command: 'echo file' }]);
  });

  it('PUT with empty array writes an explicit empty list (so teammates pick up the cleared state on pull)', async () => {
    // First populate the file ...
    await PUT(
      new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions: [{ name: 'deploy', command: './deploy.sh' }] }),
      }),
      { params: Promise.resolve({ projectName: 'proj1' }) }
    );
    const cfgPath = join(tmpDir, '.tamtam', 'config.yml');
    expect(readFileSync(cfgPath, 'utf-8')).toContain('deploy');

    // ... then clear with an empty array.
    await PUT(
      new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions: [] }),
      }),
      { params: Promise.resolve({ projectName: 'proj1' }) }
    );
    const content = readFileSync(cfgPath, 'utf-8');
    expect(content).not.toContain('deploy');
    // The empty state must be explicit so the file actively clears teammates'
    // DB-stored actions on pull, rather than silently falling back to local DB.
    expect(content).toContain('custom_actions:');

    // And a subsequent GET returns [] because the file is authoritative.
    const response = await GET(
      new NextRequest('http://localhost/api/projects/by-project/proj1/action'),
      { params: Promise.resolve({ projectName: 'proj1' }) }
    );
    expect((await response.json()).actions).toEqual([]);
  });

  it('GET returns [] when file declares an explicitly empty custom_actions (file is authoritative, not DB)', async () => {
    // DB still has actions ...
    testDb.sqlite
      .prepare('UPDATE projects SET custom_actions = ? WHERE name = ?')
      .run(JSON.stringify([{ name: 'from-db', command: 'echo db' }]), 'proj1');

    // ... but the file declares custom_actions: [].
    mkdirSync(join(tmpDir, '.tamtam'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.tamtam', 'config.yml'),
      'actions:\n  custom_actions: []\n'
    );

    const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action');
    const response = await GET(request, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await response.json();
    expect(data.actions).toEqual([]);
  });
});

describe('action API POST pause gate', () => {
  let POST: any;
  let tmpDir: string;
  let jobsPausedResultMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let spawnMock: ReturnType<typeof vi.fn>;
  let procOnMock: ReturnType<typeof vi.fn>;
  let procUnrefMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = join(tmpdir(), `tamtam-action-post-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });

    jobsPausedResultMock = vi.fn();
    createJobMock = vi.fn(() => ({
      id: 'job-123',
      pid: 0,
      logPath: '',
      exitCode: null,
      finishedAt: null,
    }));
    updateJobMock = vi.fn();
    procOnMock = vi.fn();
    procUnrefMock = vi.fn();
    spawnMock = vi.fn(() => ({
      pid: 4321,
      on: procOnMock,
      unref: procUnrefMock,
    }));

    vi.doMock('@/lib/db', () => ({ db: {}, schema: {} }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: (projectName: string) => projectName === 'proj1' ? tmpDir : null,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ log_dir: join(tmpDir, 'logs') }),
    }));
    vi.doMock('@/lib/shared/job-control', () => ({
      jobsPausedResult: jobsPausedResultMock,
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/skills/tamtam-file-config', () => ({
      loadFileConfig: () => ({ custom_actions: [{ name: 'Deploy', command: 'pnpm deploy' }] }),
      writeFileConfig: vi.fn(),
    }));
    vi.doMock('child_process', () => ({
      spawn: spawnMock,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/action/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 409 and does not spawn when jobs are paused', async () => {
    jobsPausedResultMock.mockReturnValue({
      ok: false,
      status: 409,
      detail: 'Jobs are paused globally. Turn the switch back on in Settings to run custom action "Deploy".',
    });

    const response = await POST(
      new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'Deploy' }),
      }),
      { params: Promise.resolve({ projectName: 'proj1' }) }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      detail: 'Jobs are paused globally. Turn the switch back on in Settings to run custom action "Deploy".',
    });
    expect(jobsPausedResultMock).toHaveBeenCalledWith('run custom action "Deploy"');
    expect(createJobMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('starts the custom action normally after jobs resume', async () => {
    jobsPausedResultMock.mockReturnValue(null);

    const response = await POST(
      new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'Deploy' }),
      }),
      { params: Promise.resolve({ projectName: 'proj1' }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'started',
      job_id: 'job-123',
      pid: 4321,
      action: 'Deploy',
    });
    expect(createJobMock).toHaveBeenCalledWith('proj1', 'Deploy', 0, '');
    expect(spawnMock).toHaveBeenCalledWith('bash', ['-c', 'pnpm deploy'], expect.objectContaining({
      cwd: tmpDir,
      detached: true,
    }));
    expect(procUnrefMock).toHaveBeenCalledOnce();
    expect(updateJobMock).toHaveBeenCalled();
  });
});
