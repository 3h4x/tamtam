import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      name text NOT NULL,
      project text NOT NULL,
      skill_ids text NOT NULL DEFAULT '[]',
      doc_paths text NOT NULL DEFAULT '[]',
      model text NOT NULL DEFAULT 'normal',
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
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    project: 'proj1',
    kind: 'agent:Other Agent',
    prompt: null,
    pid: 99999,
    logPath: null,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  };
}

describe('POST /api/agents/{agentId}/run readOnly', () => {
  let sharedHandle: TestDbHandle;
  let POST: any;
  let startJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let enqueueAgentRunMock: ReturnType<typeof vi.fn>;
  let tryClaimAgentStartSlotMock: ReturnType<typeof vi.fn>;
  let findBlockingRunningJobMock: ReturnType<typeof vi.fn>;
  let getDirtyFileCountMock: ReturnType<typeof vi.fn>;
  let settingsMock: Record<string, unknown>;

  async function insertAgent() {
    const now = Date.now() / 1000;
    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-123',
      name: 'cto',
      project: 'proj1',
      skillIds: '["agent-cto"]',
      docPaths: '[]',
      model: 'smart',
      prompt: '',
      schedule: '24h',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
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

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE agents, projects'));
    startJobMock = vi.fn().mockResolvedValue(12345);
    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn().mockResolvedValue('running');
    enqueueAgentRunMock = vi.fn();
    tryClaimAgentStartSlotMock = vi.fn().mockReturnValue({ ok: true });
    findBlockingRunningJobMock = vi.fn().mockResolvedValue(null);
    getDirtyFileCountMock = vi.fn().mockResolvedValue(0);
    settingsMock = {
      dirty_worktree_block_threshold: 0,
      permission_mode: 'bypassPermissions',
      cli_bin_claude: '',
      cli_bin_codex: '',
      cli_bin_gemini: '',
      cli_bin_lmstudio: '',
      claude_bin: 'claude',
      base_prompt: '',
    };

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue('/tmp/proj1') }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getImproveConfig: vi.fn().mockReturnValue({ logDir: '/tmp/logs' }) }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({
      getPendingRelease: vi.fn().mockReturnValue(false),
      drainPendingRelease: vi.fn(),
    }));
    vi.doMock('@/lib/agents/queued-agent-runs', () => ({ enqueueQueuedAgentRun: vi.fn() }));
    vi.doMock('@/lib/agents/compose-skills', () => ({
      composeAgentSkills: vi.fn().mockReturnValue({ docParts: [], parts: [], metaSkills: [], metaDocs: [] }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: vi.fn().mockImplementation((project: string, kind: string) => makeJob({ id: 'started-job', project, kind })),
      updateJob: vi.fn(),
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
      markDone: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/jobs/inline-agent', () => ({ startInProcessAgentJob: startJobMock }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    }));
    vi.doMock('@/lib/agents/agent-memory', () => ({
      getAgentMemoryDir: vi.fn().mockReturnValue('/tmp/memory'),
      getAgentMemoryPath: vi.fn().mockReturnValue('/tmp/memory/proj1/cto.md'),
      readAgentMemory: vi.fn().mockReturnValue(null),
      readAgentMemoryDetailed: vi.fn().mockReturnValue(null),
      ensureAgentMemoryDir: vi.fn(),
      buildMemoryBlock: vi.fn().mockReturnValue(''),
    }));
    vi.doMock('@/lib/agents/pending-agent-run', () => ({
      enqueueAgentRun: enqueueAgentRunMock,
      tryClaimAgentStartSlot: tryClaimAgentStartSlotMock,
      releaseAgentStartSlot: vi.fn(),
      drainNextAgentRun: vi.fn(),
    }));
    vi.doMock('@/lib/shared/config', () => ({
      withBasePrompt: (prompt: string) => prompt,
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getSettings: () => settingsMock,
    }));
    vi.doMock('@/lib/shared/cli-bin', () => ({
      resolveCliBin: vi.fn().mockReturnValue('claude'),
      resolveCliEnv: vi.fn().mockReturnValue({}),
    }));
    vi.doMock('@/lib/jobs/project-active-job', () => ({ findBlockingRunningJob: findBlockingRunningJobMock }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }),
    }));
    vi.doMock('@/lib/git/dirty-worktree', () => ({ getDirtyFileCount: getDirtyFileCountMock }));
    vi.doMock('@/lib/agents/intake-workflow', () => ({
      runAgentIntakeWorkflow: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('workflow/api', () => ({
      // Invoke the workflow function with its args so downstream mocks
      // (startInProcessAgentJob) get exercised.
      start: vi.fn().mockImplementation(async (fn: any, args: any[]) => {
        const { startInProcessAgentJob } = await import('@/lib/jobs/inline-agent');
        await startInProcessAgentJob(args?.[0]?.jobId ?? 'started-job', 'noop', '', '/tmp');
        return fn(...(args ?? []));
      }),
    }));

    const mod = await import('@/app/api/agents/[agentId]/run/route');
    POST = mod.POST;
  });

  it('starts immediately when a different agent is already running on the same project', async () => {
    await insertAgent();
    listJobsMock.mockReturnValue([makeJob({ id: 'other-agent', kind: 'agent:Other Agent' })]);

    const res = await POST(new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'plan this issue', readOnly: true }),
    }), { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    expect(startJobMock).toHaveBeenCalledOnce();
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
    expect(tryClaimAgentStartSlotMock).not.toHaveBeenCalled();
  });

  it('starts when the dirty-worktree threshold would block a normal agent', async () => {
    await insertAgent();
    settingsMock.dirty_worktree_block_threshold = 20;
    getDirtyFileCountMock.mockResolvedValue(38);

    const res = await POST(new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'plan this issue', readOnly: true }),
    }), { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    expect(startJobMock).toHaveBeenCalledOnce();
    expect(getDirtyFileCountMock).not.toHaveBeenCalled();
  });

  it('still rejects when the same agent is already running', async () => {
    await insertAgent();
    listJobsMock.mockReturnValue([makeJob({ id: 'same-agent', kind: 'agent:cto' })]);

    const res = await POST(new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'plan this issue', readOnly: true }),
    }), { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.code).toBe('already_running');
    expect(startJobMock).not.toHaveBeenCalled();
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
  });
});
