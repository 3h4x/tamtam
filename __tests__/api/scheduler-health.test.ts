import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      name text NOT NULL,
      project text NOT NULL,
      skill_ids text NOT NULL DEFAULT '[]',
      doc_paths text NOT NULL DEFAULT '[]',
      model text NOT NULL DEFAULT 'sonnet',
      prompt text NOT NULL DEFAULT '',
      schedule text,
      runner text NOT NULL DEFAULT 'pm2',
      enabled boolean NOT NULL DEFAULT true,
      provider text,
      prerequisite_command text,
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
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
      release_after_run boolean DEFAULT false,
      pr_workflow_enabled boolean DEFAULT false,
      issue_auto_branch boolean DEFAULT true,
      last_push_error text,
      last_push_at double precision,
      review_prompt_addendum text,
      fix_prompt_addendum text,
      website text,
      qa_url text,
      archived boolean NOT NULL DEFAULT false,
      paused boolean NOT NULL DEFAULT false
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY,
      project text NOT NULL,
      kind text NOT NULL,
      prompt text,
      pid integer NOT NULL DEFAULT 0,
      log_path text,
      started_at double precision NOT NULL DEFAULT 0,
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
      provider text
    )
  `));
}

describe('GET /api/agents/scheduler-health', () => {
  let sharedHandle: TestDbHandle;
  let GET: any;
  let POST: any;
  let execMock: ReturnType<typeof vi.fn>;
  let dumpInternalSchedulerMock: ReturnType<typeof vi.fn>;
  let upsertAgentScheduleMock: ReturnType<typeof vi.fn>;
  const now = Date.now() / 1000;

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

  async function insertAgent(overrides: Record<string, unknown> = {}) {
    await sharedHandle.db.insert(schema.agents).values({
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
    });
  }

  async function insertProject(name: string, path: string, enabled = true) {
    await sharedHandle.db.execute(sql.raw(
      `INSERT INTO projects (name, path, enabled) VALUES ('${name}', '${path}', ${enabled ? 'true' : 'false'})`,
    ));
  }

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE agents, projects, jobs'));

    execMock = vi.fn();
    dumpInternalSchedulerMock = vi.fn().mockReturnValue({ started: true, entries: [] });
    upsertAgentScheduleMock = vi.fn();

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
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

    const enabledProjects = await import('@/lib/shared/enabled-projects');
    enabledProjects.clearProjectsCache();
    await enabledProjects.refreshProjectsCacheSync();

    const mod = await import('@/app/api/agents/scheduler-health/route');
    GET = mod.GET;
    POST = mod.POST;
  });

  it('reports ok when DB schedule matches an internal-scheduler entry', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', runner: 'pm2', schedule: '1h' });
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
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', runner: 'pm2', schedule: '1h' });
    dumpInternalSchedulerMock.mockReturnValue({ started: true, entries: [] });
    execMock.mockImplementation(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.missing).toHaveLength(1);
    expect(body.missing[0].id).toBe('agent-1');
  });

  it('flags an orphan when the internal scheduler has an agent not in the DB', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', runner: 'pm2', schedule: '1h' });
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
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'Disabled', runner: 'pm2', schedule: '1h', enabled: false });
    await insertAgent({ id: 'agent-2', project: 'projA', name: 'Manual', runner: 'pm2', schedule: null });
    dumpInternalSchedulerMock.mockReturnValue({ started: true, entries: [] });
    execMock.mockImplementation(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const res = await GET();
    const body = await res.json();
    expect(body.expected).toHaveLength(0);
    expect(body.ok).toBe(true);
  });

  it('POST installs missing schedules and re-runs the check', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', runner: 'pm2', schedule: '1h' });

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
    await insertProject('proj1', '/w/proj1', true);

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

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: () => ({ launchagent_prefix: 'com.tamtam' }) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getImproveConfig: () => ({ logDir: '/tmp', claudeBin: 'claude' }) }));
    vi.doMock('@/lib/scheduling/internal-scheduler', () => internalSchedulerStub);
    vi.doMock('./internal-scheduler', () => internalSchedulerStub);
    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({ scanFileAgents: vi.fn().mockReturnValue([fileAgent]) }));

    const enabledProjects = await import('@/lib/shared/enabled-projects');
    enabledProjects.clearProjectsCache();
    await enabledProjects.refreshProjectsCacheSync();

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
    await insertProject('proj1', '/w/proj1', true);
    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-db', name: 'shared', project: 'proj1', skillIds: '[]', model: 'sonnet',
      prompt: 'db version', schedule: '1h', runner: 'pm2', enabled: true,
      createdAt: now, updatedAt: now,
    });

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

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: () => ({ launchagent_prefix: 'com.tamtam' }) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getImproveConfig: () => ({ logDir: '/tmp', claudeBin: 'claude' }) }));
    vi.doMock('@/lib/scheduling/internal-scheduler', () => internalSchedulerStub);
    vi.doMock('./internal-scheduler', () => internalSchedulerStub);
    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({ scanFileAgents: vi.fn().mockReturnValue([fileAgent]) }));

    const enabledProjects = await import('@/lib/shared/enabled-projects');
    enabledProjects.clearProjectsCache();
    await enabledProjects.refreshProjectsCacheSync();

    const { GET: GET3 } = await import('@/app/api/agents/scheduler-health/route');
    const res = await GET3();
    const body = await res.json();

    // Only the DB agent should appear; no duplicate from the file agent.
    expect(body.expected).toHaveLength(1);
    expect(body.expected[0].id).toBe('agent-db');
    expect(body.ok).toBe(true);
  });
});
