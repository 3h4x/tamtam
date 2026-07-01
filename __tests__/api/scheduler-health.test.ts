import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
      enabled boolean NOT NULL DEFAULT true,
      boostable boolean NOT NULL DEFAULT true,
      provider text,
      fallback_enabled boolean NOT NULL DEFAULT false,
      prerequisite_command text,
      permission_mode text,
      kind text NOT NULL DEFAULT 'user',
      role text NOT NULL DEFAULT 'producer',
      autopilot_state text,
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
      post_merge_watch_minutes integer DEFAULT 0,
      auto_revert_enabled boolean DEFAULT false,
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
      dev_server_start_command text,
      dev_server_stop_command text,
      dev_server_ready_url text,
      daily_spend_cap_usd double precision,
      release_spend_cap_usd double precision,
      setup_complete boolean NOT NULL DEFAULT false,
      setup_state text NOT NULL DEFAULT '{}',
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
      lines_added integer,
      lines_removed integer,
      provider text,
      run_score integer,
      skill_ids text NOT NULL DEFAULT '[]'
    )
  `));
}

describe('GET /api/agents/scheduler-health', () => {
  let sharedHandle: TestDbHandle;
  let GET: any;
  let POST: any;
  let logDir: string;
  let quickAddJobMock: ReturnType<typeof vi.fn>;
  let queuedJobKeys: Set<string>;
  const now = Date.now() / 1000;

  function promptPath(agentId: string): string {
    return join(logDir, 'agent-scripts', `${agentId}.prompt.json`);
  }
  function seedPromptFile(agentId: string): void {
    mkdirSync(join(logDir, 'agent-scripts'), { recursive: true });
    writeFileSync(promptPath(agentId), JSON.stringify({ prompt: 'seeded' }));
  }
  function seedQueueJob(agentId: string): void {
    queuedJobKeys.add(`agent-cron-${agentId}`);
  }
  function queueRows() {
    return [...queuedJobKeys].map((key) => ({
      key,
      run_at: new Date(Date.now() + 60_000),
      attempts: 0,
      is_available: true,
      locked_at: null,
      last_error: null,
    }));
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
    queuedJobKeys = new Set();
    quickAddJobMock = vi.fn().mockImplementation(async (_options, _task, _payload, spec) => {
      if (spec?.jobKey) queuedJobKeys.add(spec.jobKey);
    });

    vi.doMock('graphile-worker', () => ({ quickAddJob: quickAddJobMock }));
    vi.doMock('pg', () => ({
      Pool: vi.fn(function PoolMock() {
        return {
          query: vi.fn(async () => ({
            rows: queueRows(),
          })),
          on: vi.fn(),
          end: vi.fn(async () => undefined),
        };
      }),
    }));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ launchagent_prefix: 'com.tamtam' }),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir, claudeBin: 'claude' }),
    }));

    const enabledProjects = await import('@/lib/shared/enabled-projects');
    enabledProjects.clearProjectsCache();
    await enabledProjects.refreshProjectsCacheSync();

    const mod = await import('@/app/api/agents/scheduler-health/route');
    GET = mod.GET;
    POST = mod.POST;
  });

  it('reports ok when each enabled scheduled DB agent has a prompt file and Graphile job', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', schedule: '1h' });
    seedPromptFile('agent-1');
    seedQueueJob('agent-1');

    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.expected).toHaveLength(1);
    expect(body.actual.graphile).toEqual(['agent-cron-agent-1']);
    expect(body.missing).toEqual([]);
  });

  it('populates internal entries from Graphile cron state for Next Run UI', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', schedule: '1h' });
    seedPromptFile('agent-1');
    seedQueueJob('agent-1');

    const res = await GET();
    const body = await res.json();

    expect(body.internal.entries).toHaveLength(1);
    expect(body.internal.entries[0]).toMatchObject({
      agentId: 'agent-1',
      project: 'projA',
      name: 'My Agent',
      schedule: '1h',
      enabled: true,
      lastError: null,
    });
    expect(body.internal.entries[0].nextFireMs).toBeGreaterThan(Date.now());
  });

  it('flags an agent as missing when no prompt file exists for it', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', schedule: '1h' });
    seedQueueJob('agent-1');

    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.missing).toHaveLength(1);
    expect(body.missing[0].id).toBe('agent-1');
    expect(body.missing[0].promptFileLoaded).toBe(false);
    expect(body.missing[0].queueLoaded).toBe(true);
  });

  it('flags an agent as missing when the prompt file exists but the Graphile job is absent', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', schedule: '1h' });
    seedPromptFile('agent-1');

    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.missing).toHaveLength(1);
    expect(body.missing[0].id).toBe('agent-1');
    expect(body.missing[0].promptFileLoaded).toBe(true);
    expect(body.missing[0].queueLoaded).toBe(false);
    expect(body.internal.entries).toEqual([]);
  });

  it('skips disabled and unscheduled agents from the expected set', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'Disabled', schedule: '1h', enabled: false });
    await insertAgent({ id: 'agent-2', project: 'projA', name: 'Manual', schedule: null });

    const res = await GET();
    const body = await res.json();
    expect(body.expected).toHaveLength(0);
    expect(body.ok).toBe(true);
  });

  it('POST installs missing schedules and re-runs the check', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', schedule: '1h' });
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

  it('POST reinstalls a schedule when only the Graphile queue job is missing', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', schedule: '1h' });
    seedPromptFile('agent-1');

    const res = await POST();
    const body = await res.json();
    expect(body.before.ok).toBe(false);
    expect(body.before.missing[0].queueLoaded).toBe(false);
    expect(body.installed).toEqual(['tamtam-projA-agent-My Agent']);
    expect(body.after.ok).toBe(true);
    expect(quickAddJobMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a GET refresh started before POST repopulate the health cache', async () => {
    await insertAgent({ id: 'agent-1', project: 'projA', name: 'My Agent', schedule: '1h' });

    vi.resetModules();
    const firstQuery = deferred<{ rows: ReturnType<typeof queueRows> }>();
    let queryCalls = 0;

    vi.doMock('graphile-worker', () => ({ quickAddJob: quickAddJobMock }));
    vi.doMock('pg', () => ({
      Pool: vi.fn(function PoolMock() {
        return {
          query: vi.fn(async () => {
            queryCalls += 1;
            if (queryCalls === 1) return firstQuery.promise;
            return { rows: queueRows() };
          }),
          on: vi.fn(),
          end: vi.fn(async () => undefined),
        };
      }),
    }));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: () => ({ launchagent_prefix: 'com.tamtam' }) }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getImproveConfig: () => ({ logDir, claudeBin: 'claude' }) }));

    const enabledProjects = await import('@/lib/shared/enabled-projects');
    enabledProjects.clearProjectsCache();
    await enabledProjects.refreshProjectsCacheSync();

    const { GET: raceGET, POST: racePOST } = await import('@/app/api/agents/scheduler-health/route');
    const oldGet = raceGET();
    await vi.waitFor(() => expect(queryCalls).toBeGreaterThan(0));

    const postRes = await racePOST();
    const postBody = await postRes.json();
    expect(postBody.after.ok).toBe(true);

    firstQuery.resolve({ rows: [] });
    await oldGet;

    const finalRes = await raceGET();
    const finalBody = await finalRes.json();
    expect(finalBody.ok).toBe(true);
    expect(finalBody.missing).toEqual([]);
  });
});
