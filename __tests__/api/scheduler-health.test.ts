import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      skill_ids TEXT NOT NULL DEFAULT '[]',
      doc_paths TEXT NOT NULL DEFAULT '[]',
      model TEXT NOT NULL DEFAULT 'sonnet',
      prompt TEXT NOT NULL DEFAULT '',
      schedule TEXT,
      runner TEXT NOT NULL DEFAULT 'pm2',
      enabled INTEGER NOT NULL DEFAULT 1,
      provider TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
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
      release_after_run INTEGER DEFAULT 0,
      pr_workflow_enabled INTEGER DEFAULT 0,
      issue_auto_branch INTEGER DEFAULT 1,
      last_push_error TEXT,
      last_push_at REAL,
      review_prompt_addendum TEXT,
      fix_prompt_addendum TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      pid INTEGER NOT NULL DEFAULT 0,
      log_path TEXT,
      started_at REAL NOT NULL DEFAULT 0,
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

describe('GET /api/agents/scheduler-health', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let GET: any;
  let POST: any;
  let execMock: ReturnType<typeof vi.fn>;
  let dumpInternalSchedulerMock: ReturnType<typeof vi.fn>;
  let upsertAgentScheduleMock: ReturnType<typeof vi.fn>;
  const now = Date.now() / 1000;

  function insertAgent(overrides: Record<string, unknown> = {}) {
    testDb.db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'My Agent',
      project: 'projA',
      skillIds: '[]',
      model: 'sonnet',
      prompt: 'do stuff',
      schedule: '1h',
      runner: 'pm2',
      enabled: true,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }).run();
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    execMock = vi.fn();
    dumpInternalSchedulerMock = vi.fn().mockReturnValue({ started: true, entries: [] });
    upsertAgentScheduleMock = vi.fn();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ launchagent_prefix: 'com.tamtam' }),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-logs', claudeBin: 'claude' }),
    }));
    const internalSchedulerStub = {
      dumpInternalScheduler: dumpInternalSchedulerMock,
      upsertAgentSchedule: upsertAgentScheduleMock,
      removeAgentSchedule: vi.fn(),
    };
    vi.doMock('@/lib/scheduling/internal-scheduler', () => internalSchedulerStub);
    // agent-scheduler.ts imports via the relative path './internal-scheduler' —
    // Vitest treats relative and aliased paths as separate modules.
    vi.doMock('./internal-scheduler', () => internalSchedulerStub);
    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({ scanFileAgents: vi.fn().mockReturnValue([]) }));

    const mod = await import('@/app/api/agents/scheduler-health/route');
    GET = mod.GET;
    POST = mod.POST;
  });

  it('reports ok when DB schedule matches an internal-scheduler entry', async () => {
    insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', runner: 'pm2', schedule: '1h' });
    dumpInternalSchedulerMock.mockReturnValue({
      started: true,
      entries: [{ agentId: 'agent-1', project: 'projA', name: 'My Agent', schedule: '1h', enabled: true, nextFireMs: Date.now() + 1000, lastFireMs: null, fireCount: 0, errorCount: 0, lastError: null }],
    });
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'launchctl' && args[0] === 'list') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.expected).toHaveLength(1);
    expect(body.missing).toEqual([]);
    expect(body.orphans.pm2).toEqual([]);
    expect(body.internal.entries).toHaveLength(1);
  });

  it('flags missing schedule when DB agent is not in the internal scheduler', async () => {
    insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', runner: 'pm2', schedule: '1h' });
    dumpInternalSchedulerMock.mockReturnValue({ started: true, entries: [] });
    execMock.mockImplementation(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.missing).toHaveLength(1);
    expect(body.missing[0].id).toBe('agent-1');
  });

  it('flags an orphan when the internal scheduler has an agent not in the DB', async () => {
    insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', runner: 'pm2', schedule: '1h' });
    dumpInternalSchedulerMock.mockReturnValue({
      started: true,
      entries: [
        { agentId: 'agent-1', project: 'projA', name: 'My Agent', schedule: '1h', enabled: true, nextFireMs: Date.now() + 1000, lastFireMs: null, fireCount: 0, errorCount: 0, lastError: null },
        { agentId: 'agent-stale', project: 'projA', name: 'Stale Agent', schedule: '1h', enabled: true, nextFireMs: Date.now() + 1000, lastFireMs: null, fireCount: 0, errorCount: 0, lastError: null },
      ],
    });
    execMock.mockImplementation(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.orphans.pm2).toEqual(['projA/Stale Agent']);
  });

  it('skips disabled and unscheduled agents from expected set', async () => {
    insertAgent({ id: 'agent-1', project: 'projA', name: 'Disabled', runner: 'pm2', schedule: '1h', enabled: false });
    insertAgent({ id: 'agent-2', project: 'projA', name: 'Manual', runner: 'pm2', schedule: null });
    dumpInternalSchedulerMock.mockReturnValue({ started: true, entries: [] });
    execMock.mockImplementation(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const res = await GET();
    const body = await res.json();
    expect(body.expected).toHaveLength(0);
    expect(body.ok).toBe(true);
  });

  it('detects launchctl orphans by configured prefix', async () => {
    dumpInternalSchedulerMock.mockReturnValue({ started: true, entries: [] });
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'launchctl' && args[0] === 'list') {
        return {
          exitCode: 0,
          stdout: '-\t0\tcom.tamtam.agent.zombie\n-\t0\tcom.apple.something\n',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const res = await GET();
    const body = await res.json();
    expect(body.orphans.launchctl).toEqual(['com.tamtam.agent.zombie']);
  });

  it('POST installs missing schedules and re-runs the check', async () => {
    insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', runner: 'pm2', schedule: '1h' });

    let internalEntries: any[] = [];
    dumpInternalSchedulerMock.mockImplementation(() => ({ started: true, entries: internalEntries.slice() }));
    upsertAgentScheduleMock.mockImplementation((agent: any) => {
      internalEntries.push({
        agentId: agent.id, project: agent.project, name: agent.name, schedule: agent.schedule,
        enabled: true, nextFireMs: Date.now() + 1000, lastFireMs: null, fireCount: 0, errorCount: 0, lastError: null,
      });
    });
    execMock.mockImplementation(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const res = await POST();
    const body = await res.json();
    expect(body.before.ok).toBe(false);
    expect(body.installed.length).toBeGreaterThan(0);
    expect(body.after.ok).toBe(true);
  });

  it('includes file-based agents from enabled projects in the expected set', async () => {
    const fileAgent = {
      id: 'file:proj1:auto-check',
      project: 'proj1',
      name: 'auto-check',
      schedule: '2h',
      prompt: 'run checks',
      enabled: true,
      runner: 'pm2',
    };

    // Reset module registry so the new mocks take effect for the route import.
    vi.resetModules();
    testDb = createTestDb();
    testDb.sqlite.exec(`INSERT INTO projects (name, path, enabled) VALUES ('proj1', '/w/proj1', 1)`);

    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    dumpInternalSchedulerMock = vi.fn().mockReturnValue({
      started: true,
      entries: [{ agentId: 'file:proj1:auto-check', project: 'proj1', name: 'auto-check', schedule: '2h', enabled: true, nextFireMs: Date.now() + 1000, lastFireMs: null, fireCount: 0, errorCount: 0, lastError: null }],
    });
    upsertAgentScheduleMock = vi.fn();
    const internalSchedulerStub = {
      dumpInternalScheduler: dumpInternalSchedulerMock,
      upsertAgentSchedule: upsertAgentScheduleMock,
      removeAgentSchedule: vi.fn(),
    };

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: () => ({ launchagent_prefix: 'com.tamtam' }) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getImproveConfig: () => ({ logDir: '/tmp', claudeBin: 'claude' }) }));
    vi.doMock('@/lib/scheduling/internal-scheduler', () => internalSchedulerStub);
    vi.doMock('./internal-scheduler', () => internalSchedulerStub);
    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({ scanFileAgents: vi.fn().mockReturnValue([fileAgent]) }));

    const { GET: GET2 } = await import('@/app/api/agents/scheduler-health/route');
    const res = await GET2();
    const body = await res.json();

    // The file agent counts as an expected scheduled agent.
    expect(body.expected).toHaveLength(1);
    expect(body.expected[0].id).toBe('file:proj1:auto-check');
    expect(body.ok).toBe(true);
  });

  it('DB agent takes precedence over file agent with same project+name', async () => {
    // DB agent "shared" in proj1 — file agent with same name must not be double-counted.
    insertAgent({ id: 'agent-db', project: 'proj1', name: 'shared', runner: 'pm2', schedule: '1h' });
    testDb.sqlite.exec(`INSERT INTO projects (name, path, enabled) VALUES ('proj1', '/w/proj1', 1)`);
    const fileAgent = {
      id: 'file:proj1:shared',
      project: 'proj1',
      name: 'shared',
      schedule: '1h',
      prompt: 'file version',
      enabled: true,
      runner: 'pm2',
    };

    // Override the scanFileAgents mock for this test.
    vi.resetModules();
    testDb = createTestDb();
    testDb.sqlite.exec(`INSERT INTO projects (name, path, enabled) VALUES ('proj1', '/w/proj1', 1)`);
    testDb.db.insert(schema.agents).values({
      id: 'agent-db', name: 'shared', project: 'proj1', skillIds: '[]', model: 'sonnet',
      prompt: 'db version', schedule: '1h', runner: 'pm2', enabled: true,
      createdAt: now, updatedAt: now,
    }).run();

    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    dumpInternalSchedulerMock = vi.fn().mockReturnValue({
      started: true,
      entries: [{ agentId: 'agent-db', project: 'proj1', name: 'shared', schedule: '1h', enabled: true, nextFireMs: Date.now() + 1000, lastFireMs: null, fireCount: 0, errorCount: 0, lastError: null }],
    });
    upsertAgentScheduleMock = vi.fn();
    const internalSchedulerStub = {
      dumpInternalScheduler: dumpInternalSchedulerMock,
      upsertAgentSchedule: upsertAgentScheduleMock,
      removeAgentSchedule: vi.fn(),
    };

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: () => ({ launchagent_prefix: 'com.tamtam' }) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getImproveConfig: () => ({ logDir: '/tmp', claudeBin: 'claude' }) }));
    vi.doMock('@/lib/scheduling/internal-scheduler', () => internalSchedulerStub);
    vi.doMock('./internal-scheduler', () => internalSchedulerStub);
    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({ scanFileAgents: vi.fn().mockReturnValue([fileAgent]) }));

    const { GET: GET3 } = await import('@/app/api/agents/scheduler-health/route');
    const res = await GET3();
    const body = await res.json();

    // Only the DB agent should appear; no duplicate from the file agent.
    expect(body.expected).toHaveLength(1);
    expect(body.expected[0].id).toBe('agent-db');
    expect(body.ok).toBe(true);
  });
});
