import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

let sharedHandle: TestDbHandle;

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
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
      setup_complete boolean NOT NULL DEFAULT false,
      setup_state text NOT NULL DEFAULT '{}',
      archived boolean NOT NULL DEFAULT false,
      paused boolean NOT NULL DEFAULT false
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      project text NOT NULL,
      name text NOT NULL,
      model text,
      prompt text,
      schedule text,
      enabled boolean DEFAULT false,
      boostable boolean NOT NULL DEFAULT true,
      skill_ids text,
      doc_paths text NOT NULL DEFAULT '[]',
      provider text,
      fallback_enabled boolean NOT NULL DEFAULT false,
      prerequisite_command text,
      permission_mode text,
      kind text NOT NULL DEFAULT 'user',
      role text NOT NULL DEFAULT 'producer',
      autopilot_state text,
      timeout_seconds integer,
      template_id text,
      created_at double precision,
      updated_at double precision
    )
  `));
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
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 30));
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

// ─── GET /api/projects ────────────────────────────────────────────────────────

describe('GET /api/projects', () => {
  let GET: any;
  let fetchProjectDataMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    fetchProjectDataMock = vi.fn().mockResolvedValue({
      projects: {},
      priorities: [],
    });

    await sharedHandle.db.execute(sql.raw('TRUNCATE projects, agents, gh_issues_cache'));

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/project-data', () => ({
      fetchProjectData: fetchProjectDataMock,
    }));

    const mod = await import('@/app/api/projects/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns empty tasks and priorities when no projects', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toEqual([]);
    expect(data.priorities).toEqual([]);
  });

  it('flattens project tasks with project name attached', async () => {
    fetchProjectDataMock.mockResolvedValue({
      projects: {
        proj1: [{ id: 'task-1', kind: 'review' }, { id: 'task-2', kind: 'test' }],
        proj2: [{ id: 'task-3', kind: 'run' }],
      },
      priorities: ['proj1', 'proj2'],
    });

    const res = await GET();
    const data = await res.json();

    expect(data.tasks).toHaveLength(3);
    expect(data.tasks.find((t: any) => t.id === 'task-1').project).toBe('proj1');
    expect(data.tasks.find((t: any) => t.id === 'task-2').project).toBe('proj1');
    expect(data.tasks.find((t: any) => t.id === 'task-3').project).toBe('proj2');
    expect(data.priorities).toEqual(['proj1', 'proj2']);
  });
});

// ─── PATCH /api/projects/[schedId]/priority ───────────────────────────────────

describe('PATCH /api/projects/[schedId]/priority', () => {
  let PATCH: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let writePriorityYamlMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getImproveConfigMock = vi.fn().mockReturnValue({
      projects: {
        'sched-1': { project: 'proj1', scheduler: 'default', priority: 'high' },
      },
      claudeBin: 'claude',
      logDir: '/tmp/logs',
    });
    writePriorityYamlMock = vi.fn();

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: getImproveConfigMock,
      writePriorityYaml: writePriorityYamlMock,
      PRIORITY_ORDER: ['critical', 'high', 'medium', 'low'],
    }));

    const mod = await import('@/app/api/projects/[schedId]/priority/route');
    PATCH = mod.PATCH;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 422 for invalid priority value', async () => {
    const req = new NextRequest('http://localhost/api/projects/sched-1/priority', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 'urgent' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.detail).toContain('priority must be one of');
  });

  it('returns 404 for unknown schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/unknown/priority', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 'high' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ schedId: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('sets priority and returns ok', async () => {
    const req = new NextRequest('http://localhost/api/projects/sched-1/priority', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 'medium' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(writePriorityYamlMock).toHaveBeenCalledOnce();
    expect(writePriorityYamlMock).toHaveBeenCalledWith('proj1', 'default', 'medium');
  });
});

// Per-project pause/resume is now handled by PATCH /api/projects/by-project/[projectName]
// (paused field). See the by-project route handler test for coverage.

// ─── GET /api/projects/[schedId]/detail ──────────────────────────────────────

describe('GET /api/projects/[schedId]/detail', () => {
  let GET: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getImproveConfigMock = vi.fn().mockReturnValue({
      projects: {
        'sched-1': {
          project: 'proj1',
          scheduler: 'default',
          prompt: null,
          persona: [],
          github: null,
          priority: 'high',
        },
      },
    });
    listJobsMock = vi.fn().mockReturnValue([]);

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: getImproveConfigMock,
    }));

    vi.doMock('@/lib/jobs/storage', () => ({
      listJobs: listJobsMock,
    }));

    vi.doMock('os', async () => {
      const actual = await vi.importActual('os');
      return { ...actual, homedir: () => '/tmp/test-home' };
    });

    const mod = await import('@/app/api/projects/[schedId]/detail/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 for unknown schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/unknown/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('returns project detail with empty run history', async () => {
    const req = new NextRequest('http://localhost/api/projects/sched-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe('sched-1');
    expect(data.project).toBe('proj1');
    expect(data.job).toBe('default');
    expect(data.run_history).toEqual([]);
  });

  it('returns run history entries sorted newest first', async () => {
    // Feed in arbitrary order to verify the route sorts by startedAt desc.
    listJobsMock.mockReturnValue([
      { project: 'sched-1', startedAt: 1000, finishedAt: 2000, exitCode: 0 },
      { project: 'other', startedAt: 1500, finishedAt: 2500, exitCode: 7 },
      { project: 'sched-1', startedAt: 3000, finishedAt: 4000, exitCode: 1 },
    ]);

    const req = new NextRequest('http://localhost/api/projects/sched-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    const data = await res.json();

    // Filtered to sched-1 (other project dropped), sorted newest first.
    expect(data.run_history).toHaveLength(2);
    expect(data.run_history[0].exit_code).toBe(1);
    expect(data.run_history[0].duration_s).toBe(1000);
    expect(data.run_history[1].exit_code).toBe(0);
  });

  it('limits run history to the newest 20 project jobs', async () => {
    const projectJobs = Array.from({ length: 25 }, (_, i) => ({
      project: 'sched-1',
      startedAt: 1000 + i,
      finishedAt: 1010 + i,
      exitCode: i,
    }));
    listJobsMock.mockReturnValue([
      ...projectJobs.slice(10),
      { project: 'other', startedAt: 9999, finishedAt: 10000, exitCode: 99 },
      ...projectJobs.slice(0, 10),
    ]);

    const req = new NextRequest('http://localhost/api/projects/sched-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    const data = await res.json();

    expect(data.run_history).toHaveLength(20);
    expect(data.run_history[0].exit_code).toBe(24);
    expect(data.run_history.at(-1).exit_code).toBe(5);
  });

  it('returns ended=null and duration_s=null for an unfinished job', async () => {
    listJobsMock.mockReturnValue([
      { project: 'sched-1', startedAt: 5000, finishedAt: null, exitCode: null },
    ]);
    const req = new NextRequest('http://localhost/api/projects/sched-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    const data = await res.json();
    expect(data.run_history[0].ended).toBeNull();
    expect(data.run_history[0].duration_s).toBeNull();
    expect(data.run_history[0].exit_code).toBeNull();
  });

  it('includes null prompt content when no prompt path', async () => {
    const req = new NextRequest('http://localhost/api/projects/sched-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    const data = await res.json();
    expect(data.prompt_content).toBeNull();
    expect(data.memory_content).toBeNull();
  });
});

// ─── PATCH /api/projects/by-project/[projectName] (archived flag) ─────────────

describe('PATCH /api/projects/by-project/[projectName]', () => {
  let PATCH: any;
  let enabledProjects: typeof import('@/lib/shared/enabled-projects');
  const clearProjectDataCacheMock = vi.fn();
  const uninstallAgentScheduleMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    vi.resetModules();

    await sharedHandle.db.execute(sql.raw('TRUNCATE projects, agents, gh_issues_cache'));

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/project-data', () => ({
      clearProjectDataCache: clearProjectDataCacheMock,
    }));
    vi.doMock('@/lib/scheduling/agent-scheduler', () => ({
      uninstallAgentSchedule: uninstallAgentScheduleMock,
    }));

    clearProjectDataCacheMock.mockClear();
    uninstallAgentScheduleMock.mockClear();

    enabledProjects = await import('@/lib/shared/enabled-projects');
    const mod = await import('@/app/api/projects/by-project/[projectName]/route');
    PATCH = mod.PATCH;
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function seedProject(name: string, archived = false) {
    await sharedHandle.db.execute(sql.raw(
      `INSERT INTO projects (name, path, enabled, archived) VALUES ('${name}', '/tmp/${name}', true, ${archived ? 'true' : 'false'})`,
    ));
  }

  async function archivedFlag(name: string): Promise<boolean> {
    const result = await sharedHandle.db.execute(sql.raw(
      `SELECT archived FROM projects WHERE name = '${name}'`,
    ));
    const row = (result.rows ?? [])[0] as { archived: boolean } | undefined;
    return row?.archived ?? false;
  }

  it('returns 400 when archived is not a boolean', async () => {
    await seedProject('proj1');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1', {
      method: 'PATCH',
      body: JSON.stringify({ archived: 'yes' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown project', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/missing', {
      method: 'PATCH',
      body: JSON.stringify({ archived: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('archives an existing project, refreshes the project-state cache, and unschedules its agents', async () => {
    await seedProject('proj1');
    await sharedHandle.db.execute(sql.raw(
      `INSERT INTO agents (id, project, name, enabled) VALUES ('a1', 'proj1', 'qa', true)`,
    ));
    await sharedHandle.db.execute(sql.raw(
      `INSERT INTO agents (id, project, name, enabled) VALUES ('a2', 'proj1', 'review', true)`,
    ));
    await enabledProjects.refreshProjectsCacheSync();
    expect(enabledProjects.isProjectArchived('proj1')).toBe(false);

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1', {
      method: 'PATCH',
      body: JSON.stringify({ archived: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ project: 'proj1', archived: true, paused: false });
    expect(await archivedFlag('proj1')).toBe(true);
    expect(enabledProjects.isProjectArchived('proj1')).toBe(true);
    expect(clearProjectDataCacheMock).toHaveBeenCalled();
    expect(uninstallAgentScheduleMock).toHaveBeenCalledWith('a1');
    expect(uninstallAgentScheduleMock).toHaveBeenCalledWith('a2');
  });

  it('pauses an existing project and refreshes the project-state cache', async () => {
    await seedProject('proj1');
    await enabledProjects.refreshProjectsCacheSync();
    expect(enabledProjects.isProjectPaused('proj1')).toBe(false);

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1', {
      method: 'PATCH',
      body: JSON.stringify({ paused: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ project: 'proj1', archived: false, paused: true });
    expect(enabledProjects.isProjectPaused('proj1')).toBe(true);
    expect(clearProjectDataCacheMock).toHaveBeenCalled();
    expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
  });

  it('unarchives a project without touching scheduled agents', async () => {
    await seedProject('proj1', true);
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1', {
      method: 'PATCH',
      body: JSON.stringify({ archived: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ project: 'proj1', archived: false, paused: false });
    expect(await archivedFlag('proj1')).toBe(false);
    expect(clearProjectDataCacheMock).toHaveBeenCalled();
    expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
  });
});
