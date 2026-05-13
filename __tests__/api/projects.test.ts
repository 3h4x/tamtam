import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createArchiveTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE projects (
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
      release_after_run INTEGER DEFAULT 0,
      issue_auto_branch INTEGER DEFAULT 1,
      last_push_error TEXT,
      last_push_at REAL,
      review_prompt_addendum TEXT,
      fix_prompt_addendum TEXT,
      website TEXT,
      qa_url TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      name TEXT NOT NULL,
      model TEXT,
      prompt TEXT,
      schedule TEXT,
      enabled INTEGER DEFAULT 0,
      runner TEXT,
      skill_ids TEXT,
      provider TEXT,
      prerequisite_command TEXT,
      timeout_seconds INTEGER,
      template_id TEXT,
      created_at REAL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

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

// ─── POST /api/projects/[schedId]/pause ──────────────────────────────────────

describe('POST /api/projects/[schedId]/pause', () => {
  let POST: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let pauseAllMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getImproveConfigMock = vi.fn().mockReturnValue({
      projects: { 'sched-1': { project: 'proj1' } },
      claudeBin: 'claude',
      logDir: '/tmp/logs',
    });
    pauseAllMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: getImproveConfigMock,
    }));

    vi.doMock('@/lib/scheduling/launchagent', () => ({
      pauseAll: pauseAllMock,
    }));

    const mod = await import('@/app/api/projects/[schedId]/pause/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 for unknown schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/unknown/pause', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('pauses project and returns ok', async () => {
    const req = new NextRequest('http://localhost/api/projects/sched-1/pause', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(pauseAllMock).toHaveBeenCalledWith(['sched-1']);
  });
});

// ─── POST /api/projects/[schedId]/resume ─────────────────────────────────────

describe('POST /api/projects/[schedId]/resume', () => {
  let POST: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let resumeAllMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getImproveConfigMock = vi.fn().mockReturnValue({
      projects: { 'sched-1': { project: 'proj1' } },
      claudeBin: 'claude',
      logDir: '/tmp/logs',
    });
    resumeAllMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: getImproveConfigMock,
    }));

    vi.doMock('@/lib/scheduling/launchagent', () => ({
      resumeAll: resumeAllMock,
    }));

    const mod = await import('@/app/api/projects/[schedId]/resume/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 for unknown schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/unknown/resume', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('resumes project and returns ok', async () => {
    const req = new NextRequest('http://localhost/api/projects/sched-1/resume', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(resumeAllMock).toHaveBeenCalledWith(['sched-1']);
  });
});

// ─── GET /api/projects/[schedId]/detail ──────────────────────────────────────

describe('GET /api/projects/[schedId]/detail', () => {
  let GET: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let readRunHistoryMock: ReturnType<typeof vi.fn>;

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
    readRunHistoryMock = vi.fn().mockReturnValue([]);

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: getImproveConfigMock,
    }));

    vi.doMock('@/lib/jobs/run-history', () => ({
      readRunHistory: readRunHistoryMock,
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

  it('returns run history entries', async () => {
    readRunHistoryMock.mockReturnValue([
      { started: 1000, ended: 2000, durationS: 1000, exitCode: 0 },
      { started: 3000, ended: 4000, durationS: 1000, exitCode: 1 },
    ]);

    const req = new NextRequest('http://localhost/api/projects/sched-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    const data = await res.json();

    expect(data.run_history).toHaveLength(2);
    expect(data.run_history[0].exit_code).toBe(0);
    expect(data.run_history[1].exit_code).toBe(1);
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
  let testDb: ReturnType<typeof createArchiveTestDb>;
  const clearProjectDataCacheMock = vi.fn();
  const removeAgentScheduleMock = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    testDb = createArchiveTestDb();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shared/project-data', () => ({
      clearProjectDataCache: clearProjectDataCacheMock,
    }));
    vi.doMock('@/lib/scheduling/internal-scheduler', () => ({
      removeAgentSchedule: removeAgentScheduleMock,
    }));

    clearProjectDataCacheMock.mockClear();
    removeAgentScheduleMock.mockClear();

    const mod = await import('@/app/api/projects/by-project/[projectName]/route');
    PATCH = mod.PATCH;
  });

  afterEach(() => {
    vi.resetModules();
  });

  function seedProject(name: string, archived = false) {
    testDb.sqlite
      .prepare('INSERT INTO projects (name, path, enabled, archived) VALUES (?, ?, 1, ?)')
      .run(name, `/tmp/${name}`, archived ? 1 : 0);
  }

  function archivedFlag(name: string): number {
    const row = testDb.sqlite
      .prepare('SELECT archived FROM projects WHERE name = ?')
      .get(name) as { archived: number } | undefined;
    return row?.archived ?? 0;
  }

  it('returns 400 when archived is not a boolean', async () => {
    seedProject('proj1');
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

  it('archives an existing project, clears cache, and unschedules its agents', async () => {
    seedProject('proj1');
    testDb.sqlite
      .prepare('INSERT INTO agents (id, project, name, enabled) VALUES (?, ?, ?, 1)')
      .run('a1', 'proj1', 'qa');
    testDb.sqlite
      .prepare('INSERT INTO agents (id, project, name, enabled) VALUES (?, ?, ?, 1)')
      .run('a2', 'proj1', 'review');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1', {
      method: 'PATCH',
      body: JSON.stringify({ archived: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ project: 'proj1', archived: true });
    expect(archivedFlag('proj1')).toBe(1);
    expect(clearProjectDataCacheMock).toHaveBeenCalled();
    expect(removeAgentScheduleMock).toHaveBeenCalledWith('a1');
    expect(removeAgentScheduleMock).toHaveBeenCalledWith('a2');
  });

  it('unarchives a project without touching scheduled agents', async () => {
    seedProject('proj1', true);
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1', {
      method: 'PATCH',
      body: JSON.stringify({ archived: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ project: 'proj1', archived: false });
    expect(archivedFlag('proj1')).toBe(0);
    expect(clearProjectDataCacheMock).toHaveBeenCalled();
    expect(removeAgentScheduleMock).not.toHaveBeenCalled();
  });
});
