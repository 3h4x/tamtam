import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

// Hoisted mock-state bag — every test mutates these refs and then the
// module-scoped vi.mock factories below read them. This lets us register
// `vi.mock(...)` once at module scope (so the route handler can be imported
// a single time), instead of resetting the module graph per test.
const state = vi.hoisted(() => {
  return {
    dbRef: { current: null as unknown as { select: unknown; insert: unknown; update: unknown } },
    resolveProjectPathImpl: (_projectName: string): string | null => null,
    loadFileConfigImpl: (_projectPath: string): { custom_actions?: unknown } | null => null,
    writeFileConfigImpl: (_projectPath: string, _updates: unknown): void => {},
    getSettingsImpl: (): { log_dir: string } => ({ log_dir: '/tmp/tamtam-action-default-logs' }),
    jobsPausedResultMock: vi.fn(),
    createJobMock: vi.fn(),
    updateJobMock: vi.fn(),
    spawnMock: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({
  get db() { return state.dbRef.current; },
  schema,
}));

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: (projectName: string) => state.resolveProjectPathImpl(projectName),
}));

// Mock git-branch to avoid execFileSync('git', ...) shell calls in
// loadFileConfig/writeFileConfig. The real file IO is preserved so the
// file-mirroring tests still exercise the YAML read/write code path.
vi.mock('@/lib/git/git-branch', () => ({
  getBranchContext: () => ({ isDefaultBranch: true, defaultBranch: 'main', currentBranch: 'main' }),
  getDefaultBranchSync: () => 'main',
  getCurrentBranchSync: () => 'main',
  gitShowSync: () => null,
}));

vi.mock('@/lib/skills/tamtam-file-config', async () => {
  const actual = await vi.importActual<typeof import('@/lib/skills/tamtam-file-config')>(
    '@/lib/skills/tamtam-file-config'
  );
  return {
    ...actual,
    loadFileConfig: (projectPath: string) => state.loadFileConfigImpl(projectPath),
    writeFileConfig: (projectPath: string, updates: unknown) =>
      state.writeFileConfigImpl(projectPath, updates),
  };
});

vi.mock('@/lib/shared/config', () => ({
  getSettings: () => state.getSettingsImpl(),
}));

vi.mock('@/lib/shared/job-control', () => ({
  jobsPausedResult: (...args: unknown[]) => state.jobsPausedResultMock(...args),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  createJob: (...args: unknown[]) => state.createJobMock(...args),
  updateJob: (...args: unknown[]) => state.updateJobMock(...args),
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => state.spawnMock(...args),
  };
});

// Import the route handler ONCE — the per-test isolation comes from mutating
// `state.*` refs above, not from rebuilding the module graph.
const routeMod = await import('@/app/api/projects/by-project/[projectName]/action/route');
const { GET, PUT, POST } = routeMod;

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS projects (
      name text PRIMARY KEY,
      path text NOT NULL,
      enabled boolean DEFAULT false,
      github text,
      priority text,
      custom_actions text,
      test_command text,
      tests_disabled boolean DEFAULT false,
      review_disabled boolean DEFAULT false,
      test_cron_enabled boolean DEFAULT false,
      test_cron_schedule text,
      auto_commit_enabled boolean DEFAULT false,
      auto_push_enabled boolean DEFAULT false,
      auto_pr_merge_enabled boolean DEFAULT false,
      post_merge_watch_minutes integer DEFAULT 0,
      auto_revert_enabled boolean DEFAULT false,
      pr_workflow_enabled boolean DEFAULT false,
      release_after_run boolean DEFAULT false,
      issue_auto_branch boolean DEFAULT true,
      last_push_error text,
      last_push_at double precision,
      review_prompt_addendum text,
      review_prerequisite_command text,
      fix_prompt_addendum text,
      website text,
      qa_url text,
      dev_server_start_command text,
      dev_server_stop_command text,
      dev_server_ready_url text,
      archived boolean NOT NULL DEFAULT false,
      paused boolean NOT NULL DEFAULT false
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY,
      project text NOT NULL,
      kind text NOT NULL,
      prompt text,
      pid integer NOT NULL,
      log_path text,
      started_at double precision NOT NULL,
      finished_at double precision,
      exit_code integer,
      seen boolean DEFAULT false,
      duration_ms integer,
      input_tokens integer,
      output_tokens integer,
      cache_read_tokens integer,
      cache_create_tokens integer,
      session_id text,
      user_prompt text,
      context_meta text,
      parent_job_id text,
      gh_issue_number integer,
      gh_issue_repo text,
      gh_issue_title text,
      log_pruned boolean DEFAULT false,
      verdict text,
      cost_usd double precision,
      model text,
      release_id text,
      aborted_at double precision,
      release_deadline_at integer,
      prompt_bytes integer,
      work_summary text,
      modified_files text,
      lines_added integer,
      lines_removed integer,
      provider text,
      run_score integer
    )
  `));
}

// Single PGlite instance shared across both DB-backed describes — booting
// PGlite is the dominant per-suite cost, so reuse it after TRUNCATE between
// tests. Hidden in a ref object so a separate describe can read it lazily.
const sharedHandleRef: { handle: TestDbHandle } = { handle: null as unknown as TestDbHandle };

beforeAll(async () => {
  sharedHandleRef.handle = await createTestPgDbEmpty();
  await applyDdl(sharedHandleRef.handle);
});

afterAll(async () => {
  try {
    await sharedHandleRef.handle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

describe('action API (GET and PUT)', () => {
  beforeEach(async () => {
    state.dbRef.current = sharedHandleRef.handle.db as unknown as typeof state.dbRef.current;
    state.resolveProjectPathImpl = () => null;
    state.loadFileConfigImpl = () => null;
    state.writeFileConfigImpl = () => {};
    await sharedHandleRef.handle.db.execute(sql.raw('TRUNCATE projects, jobs, settings'));
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
      await sharedHandleRef.handle.db
        .insert(schema.projects)
        .values({ name: 'proj1', path: '/path/to/proj1', customActions: null });

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
      await sharedHandleRef.handle.db
        .insert(schema.projects)
        .values({
          name: 'proj1',
          path: '/path/to/proj1',
          customActions: JSON.stringify(actions),
        });

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
      await sharedHandleRef.handle.db
        .insert(schema.projects)
        .values({
          name: 'proj1',
          path: '/path/to/proj1',
          customActions: 'not-valid-json',
        });

      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action');
      const response = await GET(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      const data = await response.json();
      expect(data.actions).toEqual([]);
    });

  });

  describe('PUT /projects/by-project/[projectName]/action', () => {
    beforeEach(async () => {
      await sharedHandleRef.handle.db
        .insert(schema.projects)
        .values({ name: 'proj1', path: '/path/to/proj1' });
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
  let tmpDir: string;
  // We need the real loadFileConfig/writeFileConfig for these tests so the
  // file IO happens. Re-import the actual module here once.
  let realLoadFileConfig: typeof import('@/lib/skills/tamtam-file-config').loadFileConfig;
  let realWriteFileConfig: typeof import('@/lib/skills/tamtam-file-config').writeFileConfig;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('@/lib/skills/tamtam-file-config')>(
      '@/lib/skills/tamtam-file-config'
    );
    realLoadFileConfig = actual.loadFileConfig;
    realWriteFileConfig = actual.writeFileConfig;
  });

  beforeEach(async () => {
    await sharedHandleRef.handle.db.execute(sql.raw('TRUNCATE projects, jobs, settings'));
    tmpDir = join(tmpdir(), `tamtam-action-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });

    state.dbRef.current = sharedHandleRef.handle.db as unknown as typeof state.dbRef.current;
    state.resolveProjectPathImpl = (projectName: string) => (projectName === 'proj1' ? tmpDir : null);
    // Use the real file-IO implementations for these tests; git-branch is
    // still mocked at module scope so no shell calls happen.
    state.loadFileConfigImpl = (projectPath: string) => realLoadFileConfig(projectPath);
    state.writeFileConfigImpl = (projectPath: string, updates: unknown) =>
      realWriteFileConfig(projectPath, updates as Parameters<typeof realWriteFileConfig>[1]);

    await sharedHandleRef.handle.db
      .insert(schema.projects)
      .values({ name: 'proj1', path: tmpDir, enabled: true });
  });

  afterEach(() => {
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
    await sharedHandleRef.handle.db.execute(sql.raw(
      `UPDATE projects SET custom_actions = '${JSON.stringify([{ name: 'db-only', command: 'echo db' }]).replace(/'/g, "''")}' WHERE name = 'proj1'`
    ));

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

  it('PUT still returns ok and keeps the DB state when mirroring to .tamtam/config.yml fails', async () => {
    state.writeFileConfigImpl = () => {
      throw new Error('disk full');
    };

    const actions = [{ name: 'deploy', command: './deploy.sh' }];
    const response = await PUT(
      new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions }),
      }),
      { params: Promise.resolve({ projectName: 'proj1' }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', actions });

    const getResponse = await GET(
      new NextRequest('http://localhost/api/projects/by-project/proj1/action'),
      { params: Promise.resolve({ projectName: 'proj1' }) }
    );
    expect((await getResponse.json()).actions).toEqual(actions);
  });

  it('GET returns [] when file declares an explicitly empty custom_actions (file is authoritative, not DB)', async () => {
    // DB still has actions ...
    await sharedHandleRef.handle.db.execute(sql.raw(
      `UPDATE projects SET custom_actions = '${JSON.stringify([{ name: 'from-db', command: 'echo db' }]).replace(/'/g, "''")}' WHERE name = 'proj1'`
    ));

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
  let tmpDir: string;
  let procOnMock: ReturnType<typeof vi.fn>;
  let procUnrefMock: ReturnType<typeof vi.fn>;
  let customActions: Array<{ name: string; command: string }>;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `tamtam-action-post-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });

    state.dbRef.current = {} as unknown as typeof state.dbRef.current;
    state.resolveProjectPathImpl = (projectName: string) =>
      projectName === 'proj1' ? tmpDir : null;
    state.getSettingsImpl = () => ({ log_dir: join(tmpDir, 'logs') });

    customActions = [{ name: 'Deploy', command: 'pnpm deploy' }];
    state.loadFileConfigImpl = () => ({ custom_actions: customActions });
    state.writeFileConfigImpl = () => {};

    state.jobsPausedResultMock.mockReset();
    state.createJobMock.mockReset();
    state.createJobMock.mockReturnValue({
      id: 'job-123',
      pid: 0,
      logPath: '',
      exitCode: null,
      finishedAt: null,
    });
    state.updateJobMock.mockReset();

    procOnMock = vi.fn();
    procUnrefMock = vi.fn();
    state.spawnMock.mockReset();
    state.spawnMock.mockReturnValue({
      pid: 4321,
      on: procOnMock,
      unref: procUnrefMock,
    });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 409 and does not spawn when jobs are paused', async () => {
    state.jobsPausedResultMock.mockReturnValue({
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
    expect(state.jobsPausedResultMock).toHaveBeenCalledWith('run custom action "Deploy"');
    expect(state.createJobMock).not.toHaveBeenCalled();
    expect(state.spawnMock).not.toHaveBeenCalled();
  });

  it('returns 400 before pause or spawn work when action name is missing', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ projectName: 'proj1' }) }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail: 'action name is required' });
    expect(state.jobsPausedResultMock).not.toHaveBeenCalled();
    expect(state.createJobMock).not.toHaveBeenCalled();
    expect(state.spawnMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the requested action is not present in the authoritative file actions', async () => {
    state.jobsPausedResultMock.mockReturnValue(null);
    customActions = [];
    state.dbRef.current = sharedHandleRef.handle.db as unknown as typeof state.dbRef.current;
    await sharedHandleRef.handle.db.execute(sql.raw('TRUNCATE projects, jobs, settings'));
    await sharedHandleRef.handle.db
      .insert(schema.projects)
      .values({
        name: 'proj1',
        path: tmpDir,
        customActions: JSON.stringify([{ name: 'Deploy', command: 'echo stale-db' }]),
      });

    const response = await POST(
      new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'Deploy' }),
      }),
      { params: Promise.resolve({ projectName: 'proj1' }) }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "action 'Deploy' not found" });
    expect(state.createJobMock).not.toHaveBeenCalled();
    expect(state.spawnMock).not.toHaveBeenCalled();
  });

  it('starts the custom action normally after jobs resume', async () => {
    state.jobsPausedResultMock.mockReturnValue(null);

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
    expect(state.createJobMock).toHaveBeenCalledWith('proj1', 'Deploy', 0, '');
    const spawnArgs = state.spawnMock.mock.calls[0];
    expect(spawnArgs[0]).toBe('bash');
    expect(spawnArgs[1][0]).toBe('-lc');
    expect(spawnArgs[1][1]).toContain('pnpm deploy');
    expect(spawnArgs[1][1]).toContain('redact-log-stream.js');
    expect(spawnArgs[2]).toEqual(expect.objectContaining({
      cwd: tmpDir,
      detached: true,
      stdio: 'ignore',
    }));
    expect(existsSync(join(tmpDir, 'logs', 'job-123.sh'))).toBe(false);
    expect(procUnrefMock).toHaveBeenCalledOnce();
    expect(state.updateJobMock).toHaveBeenCalled();
  });

  it('does not persist a wrapper script when the action command contains inline secrets', async () => {
    state.jobsPausedResultMock.mockReturnValue(null);
    customActions = [{
      name: 'Deploy',
      command: 'SERVICE_TOKEN=runtime-secret-value curl https://user:supersecret@example.com/path',
    }];

    const response = await POST(
      new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'Deploy' }),
      }),
      { params: Promise.resolve({ projectName: 'proj1' }) }
    );

    expect(response.status).toBe(200);
    const spawnArgs = state.spawnMock.mock.calls[0];
    expect(spawnArgs[1][0]).toBe('-lc');
    expect(spawnArgs[1][1]).toContain('SERVICE_TOKEN=runtime-secret-value');
    expect(spawnArgs[1][1]).toContain('https://user:supersecret@example.com/path');
    expect(existsSync(join(tmpDir, 'logs', 'job-123.sh'))).toBe(false);
    expect(procUnrefMock).toHaveBeenCalledOnce();
    expect(state.updateJobMock).toHaveBeenCalled();
  });
});
