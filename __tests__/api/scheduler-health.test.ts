import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL separately.
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
      review_prerequisite_command text,
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
  let logDir: string;
  let quickAddJobMock: ReturnType<typeof vi.fn>;
  const now = Date.now() / 1000;

  function promptPath(agentId: string): string {
    return join(logDir, 'agent-scripts', `${agentId}.prompt.json`);
  }
  function seedPromptFile(agentId: string): void {
    mkdirSync(join(logDir, 'agent-scripts'), { recursive: true });
    writeFileSync(promptPath(agentId), JSON.stringify({ prompt: 'seeded' }));
  }

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
    logDir = mkdtempSync(join(tmpdir(), 'tamtam-sched-health-'));
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
    try {
      rmSync(logDir, { recursive: true, force: true });
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
    // Clear any leftover prompt files from previous tests.
    try { rmSync(join(logDir, 'agent-scripts'), { recursive: true, force: true }); } catch {}

    process.env.DATABASE_URL = 'postgres://test/test';
    quickAddJobMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('graphile-worker', () => ({ quickAddJob: quickAddJobMock }));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ launchagent_prefix: 'com.tamtam' }),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir, claudeBin: 'claude' }),
    }));
    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({ scanFileAgents: vi.fn().mockReturnValue([]) }));

    const enabledProjects = await import('@/lib/shared/enabled-projects');
    enabledProjects.clearProjectsCache();
    await enabledProjects.refreshProjectsCacheSync();

    const mod = await import('@/app/api/agents/scheduler-health/route');
    GET = mod.GET;
    POST = mod.POST;
  });

  it('reports ok when each enabled scheduled DB agent has a prompt file on disk', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', runner: 'pm2', schedule: '1h' });
    seedPromptFile('agent-1');

    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.expected).toHaveLength(1);
    expect(body.missing).toEqual([]);
    expect(body.orphans.pm2).toEqual([]);
  });

  it('flags an agent as missing when no prompt file exists for it', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', runner: 'pm2', schedule: '1h' });

    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.missing).toHaveLength(1);
    expect(body.missing[0].id).toBe('agent-1');
  });

  it('skips disabled and unscheduled agents from the expected set', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'Disabled', runner: 'pm2', schedule: '1h', enabled: false });
    await insertAgent({ id: 'agent-2', project: 'projA', name: 'Manual', runner: 'pm2', schedule: null });

    const res = await GET();
    const body = await res.json();
    expect(body.expected).toHaveLength(0);
    expect(body.ok).toBe(true);
  });

  it('POST installs missing schedules and re-runs the check', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', runner: 'pm2', schedule: '1h' });
    // No prompt file → first health check sees missing → POST writes the
    // prompt file via installAgentSchedule → second health check passes.

    const res = await POST();
    const body = await res.json();
    expect(body.before.ok).toBe(false);
    expect(body.installed.length).toBeGreaterThan(0);
    expect(body.after.ok).toBe(true);
    // Should have enqueued an agent-cron job exactly once for the missing agent.
    expect(quickAddJobMock).toHaveBeenCalledTimes(1);
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

    vi.resetModules();
    await insertProject('proj1', '/w/proj1', true);
    seedPromptFile('file:proj1:auto-check');

    vi.doMock('graphile-worker', () => ({ quickAddJob: quickAddJobMock }));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: () => ({ launchagent_prefix: 'com.tamtam' }) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getImproveConfig: () => ({ logDir, claudeBin: 'claude' }) }));
    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({ scanFileAgents: vi.fn().mockReturnValue([fileAgent]) }));

    const enabledProjects = await import('@/lib/shared/enabled-projects');
    enabledProjects.clearProjectsCache();
    await enabledProjects.refreshProjectsCacheSync();

    const { GET: GET2 } = await import('@/app/api/agents/scheduler-health/route');
    const res = await GET2();
    const body = await res.json();

    expect(body.expected).toHaveLength(1);
    expect(body.expected[0].id).toBe('file:proj1:auto-check');
    expect(body.ok).toBe(true);
  });

  it('DB agent takes precedence over file agent with same project+name', async () => {
    const fileAgent = {
      id: 'file:proj1:shared',
      project: 'proj1',
      name: 'shared',
      schedule: '1h',
      prompt: 'file version',
      enabled: true,
      runner: 'pm2',
    };

    vi.resetModules();
    await insertProject('proj1', '/w/proj1', true);
    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-db', name: 'shared', project: 'proj1', skillIds: '[]', model: 'sonnet',
      prompt: 'db version', schedule: '1h', runner: 'pm2', enabled: true,
      createdAt: now, updatedAt: now,
    });
    seedPromptFile('agent-db');

    vi.doMock('graphile-worker', () => ({ quickAddJob: quickAddJobMock }));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: () => ({ launchagent_prefix: 'com.tamtam' }) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getImproveConfig: () => ({ logDir, claudeBin: 'claude' }) }));
    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({ scanFileAgents: vi.fn().mockReturnValue([fileAgent]) }));

    const enabledProjects = await import('@/lib/shared/enabled-projects');
    enabledProjects.clearProjectsCache();
    await enabledProjects.refreshProjectsCacheSync();

    const { GET: GET3 } = await import('@/app/api/agents/scheduler-health/route');
    const res = await GET3();
    const body = await res.json();

    expect(body.expected).toHaveLength(1);
    expect(body.expected[0].id).toBe('agent-db');
    expect(body.ok).toBe(true);
  });

  // The legacy `orphans.pm2` (entries in the in-memory scheduler not in the
  // DB) was retired with that scheduler — the field is always empty now and
  // its test along with it.
});
