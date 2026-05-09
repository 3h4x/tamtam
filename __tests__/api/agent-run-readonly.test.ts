import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
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
      prerequisite_command TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
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
  let testDb: ReturnType<typeof createTestDb>;
  let POST: any;
  let startJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let enqueueAgentRunMock: ReturnType<typeof vi.fn>;
  let tryClaimAgentStartSlotMock: ReturnType<typeof vi.fn>;
  let findBlockingRunningJobMock: ReturnType<typeof vi.fn>;
  let getDirtyFileCountMock: ReturnType<typeof vi.fn>;
  let settingsMock: Record<string, unknown>;

  function insertAgent() {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.agents).values({
      id: 'agent-123',
      name: 'cto',
      project: 'proj1',
      skillIds: '["agent-cto"]',
      docPaths: '[]',
      model: 'smart',
      prompt: '',
      schedule: '24h',
      runner: 'pm2',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
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

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
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
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    }));
    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({
      parseFileAgentId: vi.fn().mockReturnValue(null),
      loadFileAgent: vi.fn(),
    }));
    vi.doMock('@/lib/agents/agent-memory', () => ({
      getAgentMemoryDir: vi.fn().mockReturnValue('/tmp/memory'),
      getAgentMemoryPath: vi.fn().mockReturnValue('/tmp/memory/proj1/cto.md'),
      readAgentMemory: vi.fn().mockReturnValue(null),
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

    const mod = await import('@/app/api/agents/[agentId]/run/route');
    POST = mod.POST;
  });

  it('starts immediately when a different agent is already running on the same project', async () => {
    insertAgent();
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
    insertAgent();
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
    insertAgent();
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
