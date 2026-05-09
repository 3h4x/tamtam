import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import type { CliProvider } from '@/lib/usage/cli-providers';
import type { QuotaSnapshot } from '@/lib/usage/quota-types';

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
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-job-id',
    project: 'proj1',
    kind: 'agent:Test Agent',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  };
}

describe('POST /api/agents/{agentId}/run', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let POST: any;
  let startJobMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let runGatesMock: ReturnType<typeof vi.fn>;
  let enqueueAgentRunMock: ReturnType<typeof vi.fn>;
  let enqueueQueuedAgentRunMock: ReturnType<typeof vi.fn>;
  let drainNextAgentRunMock: ReturnType<typeof vi.fn>;
  let tryClaimAgentStartSlotMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;
  let findBlockingRunningJobMock: ReturnType<typeof vi.fn>;
  let getLockMock: ReturnType<typeof vi.fn>;
  let isLockOwnedByActiveReleaseMock: ReturnType<typeof vi.fn>;
  let getPendingReleaseMock: ReturnType<typeof vi.fn>;
  let drainPendingReleaseMock: ReturnType<typeof vi.fn>;
  let tempSkillsDir: string;
  let logDirMock: string;
  let settingsMock: Record<string, unknown>;

  const now = Date.now() / 1000;

  function insertAgent(overrides: Record<string, unknown> = {}) {
    testDb.db
      .insert(schema.agents)
      .values({
        id: 'agent-123',
        name: 'Test Agent',
        project: 'proj1',
        skillIds: '[]',
        model: 'sonnet',
        prompt: '',
        schedule: null,
        runner: 'pm2',
        createdAt: now,
        updatedAt: now,
        ...overrides,
      })
      .run();
  }

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/usage/resolve-provider');
    testDb = createTestDb();
    tempSkillsDir = mkdtempSync(join(tmpdir(), 'tamtam-agent-run-test-'));
    logDirMock = '/tmp/logs';

    startJobMock = vi.fn().mockResolvedValue(12345);
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    createJobMock = vi.fn().mockImplementation(() => makeJob());
    updateJobMock = vi.fn();
    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    execMock = vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      if (cmd === 'git' && args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 };
      if (cmd === 'bash' && args[1] === 'echo TAMTAM_PREREQ_MARKER') {
        return { stdout: 'TAMTAM_PREREQ_MARKER\n', stderr: '', exitCode: 0 };
      }
      if (cmd === 'bash' && args[1] === 'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?trusted_only=1"') {
        return { stdout: '{"issues":[{"number":1,"title":"Trusted issue"}]}\n', stderr: '', exitCode: 0 };
      }
      if (cmd === 'bash' && args[1] === 'exit 7') {
        return { stdout: '', stderr: '', exitCode: 7 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    runGatesMock = vi.fn().mockReturnValue(null);
    enqueueAgentRunMock = vi.fn();
    enqueueQueuedAgentRunMock = vi.fn();
    drainNextAgentRunMock = vi.fn().mockResolvedValue(undefined);
    tryClaimAgentStartSlotMock = vi.fn().mockReturnValue({ ok: true });
    checkCliStartGateMock = vi.fn().mockResolvedValue({ ok: true, provider: 'claude' });
    findBlockingRunningJobMock = vi.fn().mockResolvedValue(null);
    getLockMock = vi.fn().mockReturnValue(null);
    isLockOwnedByActiveReleaseMock = vi.fn().mockReturnValue(false);
    getPendingReleaseMock = vi.fn().mockReturnValue(false);
    drainPendingReleaseMock = vi.fn().mockResolvedValue(undefined);
    settingsMock = {
      workspace_path: '',
      github_owner: '',
      claude_bin: 'claude',
      log_dir: logDirMock,
      cli_bin_claude: '',
      cli_bin_codex: '',
      cli_bin_gemini: '',
      cli_bin_lmstudio: '',
      frequency: '1h',
      daytime: false,
      weekends: false,
      launchagent_prefix: 'com.tamtam',
      base_prompt: '',
      permission_mode: 'bypassPermissions',
      dirty_worktree_block_threshold: 0,
    };

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/agents/pending-agent-run', () => ({
      enqueueAgentRun: enqueueAgentRunMock,
      tryClaimAgentStartSlot: tryClaimAgentStartSlotMock,
      releaseAgentStartSlot: vi.fn(),
      drainNextAgentRun: drainNextAgentRunMock,
    }));
    vi.doMock('@/lib/agents/queued-agent-runs', () => ({
      enqueueQueuedAgentRun: enqueueQueuedAgentRunMock,
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: getLockMock,
      isLockOwnedByActiveRelease: isLockOwnedByActiveReleaseMock,
    }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({
      getPendingRelease: getPendingReleaseMock,
      drainPendingRelease: drainPendingReleaseMock,
    }));

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: execMock,
    }));

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn(() => ({ claudeBin: 'claude', logDir: logDirMock })),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));

    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
      markDone: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/jobs/project-active-job', () => ({
      findBlockingRunningJob: findBlockingRunningJobMock,
    }));

    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      startJob: startJobMock,
    }));

    vi.doMock('@/lib/skills/skills', () => ({ SKILLS_DIR: tempSkillsDir, DATA_SKILLS_DIR: join(tempSkillsDir, 'data-skills') }));

    vi.doMock('@/lib/agents/agent-memory', () => ({
      getAgentMemoryDir: vi.fn().mockReturnValue('/tmp/tamtam-memory'),
      ensureAgentMemoryDir: vi.fn(),
      getAgentMemoryPath: vi.fn().mockReturnValue('/tmp/tamtam-memory/proj1/Test Agent.md'),
      readAgentMemory: vi.fn().mockReturnValue(null),
      buildMemoryBlock: vi.fn().mockReturnValue(''),
    }));

    vi.doMock('@/lib/shared/config', () => ({
      withBasePrompt: (p: string) => p,
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getSettings: () => settingsMock,
    }));
    vi.doMock('@/lib/shared/job-control', () => ({
      runGates: runGatesMock,
      jobsPausedResult: runGatesMock,
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));
    vi.doMock('@/lib/git/dirty-worktree', () => ({
      getDirtyFileCount: vi.fn().mockResolvedValue(0),
    }));

    const mod = await import('@/app/api/agents/[agentId]/run/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempSkillsDir, { recursive: true, force: true });
  });

  it('returns 404 if agent not found', async () => {
    const req = new NextRequest('http://localhost/api/agents/nonexistent/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('agent not found');
  });

  it('returns 400 if prompt is missing', async () => {
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('prompt');
  });

  it('returns 400 if prompt is whitespace only', async () => {
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: '   ' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 if project path cannot be resolved', async () => {
    insertAgent();
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('proj1');
  });

  it('starts job and returns job info', async () => {
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBeTruthy();
    expect(data.agent).toBe('Test Agent');
    expect(drainNextAgentRunMock).toHaveBeenCalledWith('proj1');
  });

  it('keeps the Codex shim on the command line and forwards CODEX_BIN via env', async () => {
    insertAgent({ provider: 'codex' });
    checkCliStartGateMock.mockResolvedValue({ ok: true, provider: 'codex' });
    settingsMock.cli_bin_codex = '/custom/codex';

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    expect(startJobMock).toHaveBeenCalledWith(
      'test-job-id',
      expect.stringContaining('/scripts/codex-shim.js'),
      expect.any(String),
      '/path/to/proj',
      { env: { CODEX_BIN: '/custom/codex' } },
    );
  });

  it('returns 429 when every enabled provider is over budget', async () => {
    insertAgent();
    checkCliStartGateMock.mockResolvedValue({
      ok: false,
      status: 429,
      detail: 'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.',
    });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.code).toBe('providers_over_budget');
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('returns a coded 409 for scheduled runs when jobs are paused so queue drains can preserve the head', async () => {
    insertAgent({ schedule: '1h' });
    checkCliStartGateMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Jobs are paused globally. Turn the switch back on in Settings to start an agent run.',
    });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('jobs_paused');
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('rejects scheduled triggers for disabled agents before starting work', async () => {
    insertAgent({ enabled: false, schedule: '1h' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('is disabled');
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('rejects scheduled triggers for agents without schedules before starting work', async () => {
    insertAgent({ schedule: null });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('has no schedule');
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('rejects scheduled triggers when the agent is already running', async () => {
    insertAgent({ schedule: '1h' });
    listJobsMock.mockReturnValue([makeJob({ id: 'job-1', finishedAt: null })]);
    probeJobStatusMock.mockResolvedValue('running');
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('already running');
    expect(startJobMock).not.toHaveBeenCalled();
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('queues the run when a different agent is already running on the project', async () => {
    insertAgent({ schedule: '1h' });
    listJobsMock.mockReturnValue([
      makeJob({ id: 'job-other', kind: 'agent:Other Agent', finishedAt: null }),
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(202);
    expect(data.status).toBe('queued');
    expect(data.blockingJobId).toBe('job-other');
    expect(startJobMock).not.toHaveBeenCalled();
    expect(enqueueAgentRunMock).toHaveBeenCalledTimes(1);
    expect(enqueueQueuedAgentRunMock).not.toHaveBeenCalled();
    const [project, entry] = enqueueAgentRunMock.mock.calls[0];
    expect(project).toBe('proj1');
    expect(entry.agentId).toBe('agent-123');
    expect(entry.agentName).toBe('Test Agent');
    expect(entry.triggeredBy).toBe('schedule');
    expect(entry.prompt).toBe('do something');
  });

  it('returns 409 project_busy when a non-agent project job is already running', async () => {
    insertAgent({ schedule: '1h' });
    findBlockingRunningJobMock.mockResolvedValue(makeJob({ id: 'run-123', kind: 'run' }));
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.code).toBe('project_busy');
    expect(data.blockingJobId).toBe('run-123');
    expect(data.detail).toContain("Job 'run' is already running");
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('releases the starting slot after a pre-start failure so same-agent retries are not stranded', async () => {
    insertAgent({ schedule: '1h' });
    const pendingStart = deferred<void>();
    tryClaimAgentStartSlotMock
      .mockReturnValueOnce({ ok: true })
      .mockReturnValueOnce({ ok: false, runningAgent: 'Test Agent' });
    startJobMock.mockImplementationOnce(async () => {
      await pendingStart.promise;
      throw new Error('pm2 boot failed');
    });

    const reqA = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'first prompt' }),
    });
    const reqB = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'second prompt' }),
    });

    const first = POST(reqA, { params: Promise.resolve({ agentId: 'agent-123' }) });
    void first.catch(() => undefined);
    await Promise.resolve();
    const second = POST(reqB, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const resB = await second;
    pendingStart.resolve();
    const resA = await first;

    expect(resA.status).toBe(500);
    expect(resB.status).toBe(409);
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
    expect(drainNextAgentRunMock).toHaveBeenCalledWith('proj1');
  });

  it('drains the queued different agent after a pre-start failure by the slot holder', async () => {
    insertAgent({ schedule: '1h' });
    const pendingStart = deferred<void>();
    tryClaimAgentStartSlotMock.mockReturnValueOnce({ ok: true });
    startJobMock.mockImplementationOnce(async () => {
      await pendingStart.promise;
      throw new Error('pm2 boot failed');
    });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const pendingFirst = POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    void pendingFirst.catch(() => undefined);
    await Promise.resolve();

    tryClaimAgentStartSlotMock.mockReturnValueOnce({ ok: false, runningAgent: 'Other Agent' });
    const otherReq = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'queued prompt' }),
    });
    const queuedRes = await POST(otherReq, { params: Promise.resolve({ agentId: 'agent-123' }) });
    pendingStart.resolve();
    const failedRes = await pendingFirst;

    expect(queuedRes.status).toBe(202);
    expect(failedRes.status).toBe(500);
    expect(enqueueAgentRunMock).toHaveBeenCalledTimes(1);
    expect(drainNextAgentRunMock).toHaveBeenCalledWith('proj1');
  });

  it('does not queue when a different agent for the project is no longer actually running', async () => {
    insertAgent({ schedule: '1h' });
    listJobsMock.mockReturnValue([
      makeJob({ id: 'job-stale', kind: 'agent:Stale Agent', finishedAt: null }),
    ]);
    probeJobStatusMock.mockResolvedValue('done');
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(200);
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
    expect(startJobMock).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed running-job rows whose kind is not a string', async () => {
    insertAgent({ schedule: '1h' });
    listJobsMock.mockReturnValue([
      makeJob({ id: 'job-bad', kind: null, finishedAt: null }),
    ]);
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    expect(startJobMock).toHaveBeenCalledTimes(1);
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('queues in the DB-backed release-lock queue before checking running agents', async () => {
    insertAgent({ schedule: '1h' });
    isLockOwnedByActiveReleaseMock.mockReturnValue(true);
    getLockMock.mockReturnValue({ project: 'proj1', lockedByJobId: 'release-1' });
    listJobsMock.mockReturnValue([
      makeJob({ id: 'job-other', kind: 'agent:Other Agent', finishedAt: null }),
    ]);
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(202);
    expect(data.status).toBe('queued');
    expect(data.code).toBe('pipeline_lock');
    expect(data.blockingJobId).toBe('release-1');
    expect(enqueueQueuedAgentRunMock).toHaveBeenCalledTimes(1);
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
    expect(probeJobStatusMock).not.toHaveBeenCalled();
  });

  it('drains an older pending release before allowing a fresh agent start', async () => {
    insertAgent({ schedule: '1h' });
    getPendingReleaseMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    expect(drainPendingReleaseMock).toHaveBeenCalledWith('proj1');
    expect(startJobMock).toHaveBeenCalledTimes(1);
    expect(enqueueQueuedAgentRunMock).not.toHaveBeenCalled();
  });

  it('queues behind a still-pending release after retrying the drain', async () => {
    insertAgent({ schedule: '1h' });
    getPendingReleaseMock.mockReturnValue(true);
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(202);
    expect(data.status).toBe('queued');
    expect(data.code).toBe('pending_release');
    expect(drainPendingReleaseMock).toHaveBeenCalledWith('proj1');
    expect(enqueueQueuedAgentRunMock).toHaveBeenCalledTimes(1);
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('does not claim a run was queued when persisting the release-lock row fails', async () => {
    insertAgent({ schedule: '1h' });
    isLockOwnedByActiveReleaseMock.mockReturnValue(true);
    getLockMock.mockReturnValue({ project: 'proj1', lockedByJobId: 'release-1' });
    enqueueQueuedAgentRunMock.mockImplementation(() => {
      throw new Error('SQLITE_ERROR: no such table: queued_agent_runs');
    });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.detail).toContain('Failed to queue agent');
    expect(startJobMock).not.toHaveBeenCalled();
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('returns the global pause conflict when scheduled work reaches the route while jobs are paused', async () => {
    insertAgent({ schedule: '1h' });
    checkCliStartGateMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Jobs are paused globally. Turn the switch back on in Settings to start an agent run.',
    });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('Jobs are paused globally');
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('calls startJob with correct args', async () => {
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run tests' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(startJobMock).toHaveBeenCalledOnce();
    const [, cmd, fullPrompt, projPath] = startJobMock.mock.calls[0];
    expect(cmd).toContain('claude');
    expect(cmd).toContain('--model normal');
    expect(fullPrompt).toContain('run tests');
    expect(projPath).toBe('/path/to/proj');
  });

  it('passes the agent provider as a soft preference and can fall back to a healthier CLI', async () => {
    insertAgent({ provider: 'claude' });
    checkCliStartGateMock.mockResolvedValue({ ok: true, provider: 'codex' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run tests' }),
    });

    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(checkCliStartGateMock).toHaveBeenCalledWith('start an agent run', {
      preferred: 'claude',
      requestedModel: 'normal',
      respectJobsPaused: false,
    });
    const [, cmd] = startJobMock.mock.calls[0];
    expect(cmd).toContain('/scripts/codex-shim.js');
  });

  it('sanitizes an invalid stored model before building the command', async () => {
    insertAgent({ model: 'smart --resume injected' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run tests' }),
    });

    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, cmd] = startJobMock.mock.calls[0];
    expect(cmd).toContain('--model normal');
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('injected');
  });

  it('calls updateJob after startJob', async () => {
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do it' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(updateJobMock).toHaveBeenCalled();
  });

  it('composes skills into system prompt', async () => {
    testDb.db
      .insert(schema.skills)
      .values({
        id: 'skill-1',
        name: 'My Skill',
        description: 'desc',
        content: 'Skill instructions here',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    insertAgent({ skillIds: '["skill-1"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task prompt' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('## My Skill');
    expect(fullPrompt).toContain('Skill instructions here');
    expect(fullPrompt).toContain('task prompt');
  });

  it('does not prepend skill content when agent has no skills', async () => {
    insertAgent({ skillIds: '[]' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task prompt' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('task prompt');
    expect(fullPrompt).not.toContain('## My Skill');
  });

  it('returns 500 if startJob throws', async () => {
    insertAgent();
    startJobMock.mockRejectedValue(new Error('pm2 not available'));
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('pm2 not available');
    // Job must be persisted as failed so it doesn't stay "running" in the DB
    expect(updateJobMock).toHaveBeenCalled();
    const savedJob = updateJobMock.mock.calls[updateJobMock.mock.calls.length - 1][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });

  it('prepends file-based persona content when skillIds contains persona:<path>', async () => {
    const docsDir = join(tempSkillsDir, 'docs', 'skills', 'engineering-team');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'senior-fullstack.md'), 'FULLSTACK-PERSONA-BODY');

    insertAgent({ skillIds: '["persona:engineering-team/senior-fullstack"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'build it' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('FULLSTACK-PERSONA-BODY');
    expect(fullPrompt).toContain('build it');
  });

  it('mixes DB skills and file-based personas in skillIds', async () => {
    const docsDir = join(tempSkillsDir, 'docs', 'skills');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'reviewer.md'), 'REVIEWER-FILE-CONTENT');

    testDb.db
      .insert(schema.skills)
      .values({ id: 'skill-1', name: 'DB Skill', description: '', content: 'DB-SKILL-BODY', createdAt: now, updatedAt: now })
      .run();
    insertAgent({ skillIds: '["skill-1","persona:reviewer"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('DB-SKILL-BODY');
    expect(fullPrompt).toContain('REVIEWER-FILE-CONTENT');
    expect(fullPrompt).toContain('task');
  });

  it('omits the prerequisite block when the agent has no prerequisiteCommand', async () => {
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).not.toContain('## Prerequisite Output');
    expect(fullPrompt).not.toContain('Exit code:');
  });

  it('runs the prerequisite command and prepends its output to the prompt', async () => {
    mkdirSync('/tmp/logs', { recursive: true });
    resolveProjectPathMock.mockReturnValue('/tmp');
    const POST2 = POST;

    insertAgent({ prerequisiteCommand: 'echo TAMTAM_PREREQ_MARKER' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'analyze the output above' }),
    });
    await POST2(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('## Prerequisite Output');
    expect(fullPrompt).toContain('echo TAMTAM_PREREQ_MARKER');
    expect(fullPrompt).toContain('Exit code: 0');
    expect(fullPrompt).toContain('TAMTAM_PREREQ_MARKER');
    expect(fullPrompt).toContain('analyze the output above');
  });

  it('injects the trusted-only issue prerequisite for issue-cruncher agents without an explicit prerequisiteCommand', async () => {
    insertAgent({ name: 'Issue Cruncher', skillIds: '["agent-issue-cruncher"]' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'pick the next issue' }),
    });

    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(execMock).toHaveBeenCalledWith(
      'bash',
      ['-c', 'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?trusted_only=1"'],
      expect.objectContaining({ cwd: '/path/to/proj' }),
    );
    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('## Prerequisite Output');
    expect(fullPrompt).toContain('trusted_only=1');
    expect(fullPrompt).toContain('Trusted issue');
  });

  it('does not re-inject the issue-cruncher prerequisite after an explicit clear', async () => {
    insertAgent({
      name: 'Issue Cruncher',
      skillIds: '["agent-issue-cruncher"]',
      prerequisiteCommand: '',
    });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'pick the next issue' }),
    });

    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(execMock).not.toHaveBeenCalledWith(
      'bash',
      ['-c', 'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?trusted_only=1"'],
      expect.anything(),
    );
    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).not.toContain('## Prerequisite Output');
    expect(fullPrompt).not.toContain('trusted_only=1');
  });

  it('creates the log directory before writing the prerequisite artifact', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'tamtam-agent-prereq-logdir-'));
    logDirMock = join(tempRoot, 'missing-logs');
    try {
      insertAgent({ prerequisiteCommand: 'echo TAMTAM_PREREQ_MARKER' });
      const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'inspect artifact' }),
      });
      const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

      expect(res.status).toBe(200);
      const artifactPath = join(logDirMock, 'test-job-id.prereq.txt');
      expect(existsSync(artifactPath)).toBe(true);
      expect(readFileSync(artifactPath, 'utf-8')).toContain('TAMTAM_PREREQ_MARKER');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('still spawns the agent when the prerequisite exits non-zero', async () => {
    mkdirSync('/tmp/logs', { recursive: true });
    resolveProjectPathMock.mockReturnValue('/tmp');
    const POST2 = POST;

    insertAgent({ prerequisiteCommand: 'exit 7' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'inspect failure' }),
    });
    const res = await POST2(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('## Prerequisite Output');
    expect(fullPrompt).toContain('Exit code: 7');
  });

  it('creates the job row before the prerequisite runs so it is visible in the UI', async () => {
    const prereq = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      if (cmd === 'git' && args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 };
      if (cmd === 'bash' && args[1] === 'sleep 40') return prereq.promise;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    insertAgent({ prerequisiteCommand: 'sleep 40' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'inspect later' }),
    });

    const pending = POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    await vi.waitFor(() => {
      expect(createJobMock).toHaveBeenCalledOnce();
      expect(execMock).toHaveBeenCalledWith('bash', ['-c', 'sleep 40'], expect.objectContaining({ cwd: '/path/to/proj' }));
    });
    expect(startJobMock).not.toHaveBeenCalled();

    prereq.resolve({ stdout: 'done\n', stderr: '', exitCode: 0 });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(createJobMock).toHaveBeenCalledOnce();
    expect(startJobMock).toHaveBeenCalledOnce();
    expect(drainNextAgentRunMock).toHaveBeenCalledWith('proj1');
  });

  it('cancels a db-backed prerequisite run before the agent spawn begins', async () => {
    const sharedJob = makeJob();
    createJobMock.mockReturnValue(sharedJob);
    const prereq = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      if (cmd === 'git' && args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 };
      if (cmd === 'bash' && args[1] === 'sleep 40') return prereq.promise;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    insertAgent({ prerequisiteCommand: 'sleep 40' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'cancel later' }),
    });

    const pending = POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    await vi.waitFor(() => {
      expect(createJobMock).toHaveBeenCalledOnce();
      expect(execMock).toHaveBeenCalledWith('bash', ['-c', 'sleep 40'], expect.objectContaining({ cwd: '/path/to/proj' }));
    });

    const { requestJobCancellation } = await import('@/lib/jobs/cancellation');
    const cancellation = requestJobCancellation(sharedJob.id, 1_000);
    prereq.resolve({ stdout: '', stderr: '', exitCode: 130 });

    await expect(cancellation).resolves.toBe(true);
    const res = await pending;
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.status).toBe('cancelled');
    expect(startJobMock).not.toHaveBeenCalled();
    expect(sharedJob.finishedAt).not.toBeNull();
    expect(sharedJob.exitCode).toBe(130);
  });

  it('re-checks project blockers after a long prerequisite before spawning the agent', async () => {
    const prereq = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      if (cmd === 'git' && args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 };
      if (cmd === 'bash' && args[1] === 'sleep 40') return prereq.promise;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    findBlockingRunningJobMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeJob({ id: 'run-while-prereq', kind: 'run' }));
    insertAgent({ prerequisiteCommand: 'sleep 40' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'inspect later' }),
    });

    const pending = POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    await vi.waitFor(() => {
      expect(createJobMock).toHaveBeenCalledOnce();
      expect(execMock).toHaveBeenCalledWith('bash', ['-c', 'sleep 40'], expect.objectContaining({ cwd: '/path/to/proj' }));
    });

    prereq.resolve({ stdout: 'done\n', stderr: '', exitCode: 0 });
    const res = await pending;
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.code).toBe('project_busy');
    expect(data.blockingJobId).toBe('run-while-prereq');
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('creates the job row before the prerequisite runs (file agent variant)', async () => {
    const projDir = mkdtempSync(join(tmpdir(), 'tamtam-file-agent-prereq-'));
    const prereq = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    try {
      mkdirSync(join(projDir, '.tamtam', 'agents'), { recursive: true });
      writeFileSync(join(projDir, '.tamtam', 'agents', 'file-agent.md'), `---
prerequisiteCommand: "sleep 45"
---
File-backed prompt.`);
      resolveProjectPathMock.mockReturnValue(projDir);
      execMock.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        if (cmd === 'git' && args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd === 'bash' && args[1] === 'sleep 45') return prereq.promise;
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const req = new NextRequest('http://localhost/api/agents/file%3Aproj1%3Afile-agent/run', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'inspect file agent later' }),
      });

      const pending = POST(req, { params: Promise.resolve({ agentId: 'file:proj1:file-agent' }) });

      await vi.waitFor(() => {
        expect(createJobMock).toHaveBeenCalledOnce();
        expect(execMock).toHaveBeenCalledWith('bash', ['-c', 'sleep 45'], expect.objectContaining({ cwd: projDir }));
      });
      expect(startJobMock).not.toHaveBeenCalled();

      prereq.resolve({ stdout: 'file done\n', stderr: '', exitCode: 0 });
      const res = await pending;
      expect(res.status).toBe(200);
      expect(createJobMock).toHaveBeenCalledOnce();
      expect(startJobMock).toHaveBeenCalledOnce();
      expect(drainNextAgentRunMock).toHaveBeenCalledWith('proj1');
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('cancels a file-backed prerequisite run before the agent spawn begins', async () => {
    const sharedJob = makeJob();
    createJobMock.mockReturnValue(sharedJob);
    const projDir = mkdtempSync(join(tmpdir(), 'tamtam-file-agent-prereq-cancel-'));
    const prereq = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    try {
      mkdirSync(join(projDir, '.tamtam', 'agents'), { recursive: true });
      writeFileSync(join(projDir, '.tamtam', 'agents', 'file-agent.md'), `---
prerequisiteCommand: "sleep 45"
---
File-backed prompt.`);
      resolveProjectPathMock.mockReturnValue(projDir);
      execMock.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        if (cmd === 'git' && args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd === 'bash' && args[1] === 'sleep 45') return prereq.promise;
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const req = new NextRequest('http://localhost/api/agents/file%3Aproj1%3Afile-agent/run', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'cancel file agent later' }),
      });

      const pending = POST(req, { params: Promise.resolve({ agentId: 'file:proj1:file-agent' }) });

      await vi.waitFor(() => {
        expect(createJobMock).toHaveBeenCalledOnce();
        expect(execMock).toHaveBeenCalledWith('bash', ['-c', 'sleep 45'], expect.objectContaining({ cwd: projDir }));
      });

      const { requestJobCancellation } = await import('@/lib/jobs/cancellation');
      const cancellation = requestJobCancellation(sharedJob.id, 1_000);
      prereq.resolve({ stdout: '', stderr: '', exitCode: 130 });

      await expect(cancellation).resolves.toBe(true);
      const res = await pending;
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.status).toBe('cancelled');
      expect(startJobMock).not.toHaveBeenCalled();
      expect(sharedJob.finishedAt).not.toBeNull();
      expect(sharedJob.exitCode).toBe(130);
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('records resolved skills in contextMeta so the terminal toolbar can show chips', async () => {
    const docsDir = join(tempSkillsDir, 'docs', 'skills', 'engineering-team');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'senior-fullstack.md'), '---\nname: Senior Fullstack\n---\nbody');

    testDb.db
      .insert(schema.skills)
      .values({ id: 'skill-db', name: 'DB One', description: 'desc', content: 'x', createdAt: now, updatedAt: now })
      .run();
    insertAgent({ skillIds: '["skill-db","persona:engineering-team/senior-fullstack"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    // createJob is called as createJob(project, kind, pid, logPath, prompt, contextMeta, userPrompt)
    const createArgs = createJobMock.mock.calls[0];
    const contextMeta = createArgs[5];
    expect(contextMeta).toBeTruthy();
    const meta = JSON.parse(contextMeta);
    expect(meta.skills).toHaveLength(2);
    const dbChip = meta.skills.find((s: any) => s.source === 'db');
    const fileChip = meta.skills.find((s: any) => s.source === 'file');
    expect(dbChip?.name).toBe('DB One');
    expect(fileChip?.id).toBe('persona:engineering-team/senior-fullstack');
    expect(fileChip?.name).toBe('Senior Fullstack');
  });

  it('records the trigger source in contextMeta for the report finalizer', async () => {
    insertAgent({ schedule: '2h' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'task' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const createArgs = createJobMock.mock.calls[0];
    const contextMeta = JSON.parse(createArgs[5]);
    expect(contextMeta.agent.triggeredBy).toBe('schedule');
  });

  it('silently skips persona paths whose file does not exist', async () => {
    insertAgent({ skillIds: '["persona:nonexistent/missing"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(200);

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('task');
    expect(fullPrompt).not.toContain('nonexistent');
  });

  describe('dirty worktree gate', () => {
    it('rejects with 409 dirty_worktree when count >= threshold', async () => {
      vi.resetModules();
      vi.doMock('@/lib/git/dirty-worktree', () => ({
        getDirtyFileCount: vi.fn().mockResolvedValue(38),
      }));
      // Re-apply all the other mocks installed in beforeEach for the new module realm.
      vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
      vi.doMock('@/lib/agents/pending-agent-run', () => ({
        enqueueAgentRun: enqueueAgentRunMock,
        tryClaimAgentStartSlot: tryClaimAgentStartSlotMock,
        releaseAgentStartSlot: vi.fn(),
        drainNextAgentRun: drainNextAgentRunMock,
      }));
      vi.doMock('@/lib/agents/queued-agent-runs', () => ({ enqueueQueuedAgentRun: enqueueQueuedAgentRunMock }));
      vi.doMock('@/lib/pipeline/pipeline-lock', () => ({ getLock: getLockMock, isLockOwnedByActiveRelease: isLockOwnedByActiveReleaseMock }));
      vi.doMock('@/lib/pipeline/pending-release', () => ({ getPendingRelease: getPendingReleaseMock, drainPendingRelease: drainPendingReleaseMock }));
      vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
      vi.doMock('@/lib/scheduling/scheduling', () => ({
        getImproveConfig: vi.fn().mockReturnValue({ claudeBin: 'claude', logDir: '/tmp/logs' }),
        getProjectTestConfig: vi.fn().mockReturnValue(null),
      }));
      vi.doMock('@/lib/jobs/job-storage', () => ({ createJob: createJobMock, updateJob: updateJobMock, listJobs: listJobsMock, probeJobStatus: probeJobStatusMock, markDone: vi.fn().mockResolvedValue(undefined) }));
      vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
      vi.doMock('@/lib/skills/skills', () => ({ SKILLS_DIR: tempSkillsDir, DATA_SKILLS_DIR: join(tempSkillsDir, 'data-skills') }));
      vi.doMock('@/lib/agents/agent-memory', () => ({
        getAgentMemoryDir: vi.fn().mockReturnValue('/tmp/tamtam-memory'),
        ensureAgentMemoryDir: vi.fn(),
        getAgentMemoryPath: vi.fn().mockReturnValue('/tmp/tamtam-memory/proj1/Test Agent.md'),
        readAgentMemory: vi.fn().mockReturnValue(null),
        buildMemoryBlock: vi.fn().mockReturnValue(''),
      }));
      settingsMock.dirty_worktree_block_threshold = 20;
      vi.doMock('@/lib/shared/config', () => ({
        withBasePrompt: (p: string) => p,
        getPermissionModeFlag: () => '--dangerously-skip-permissions',
        getSettings: () => settingsMock,
      }));
      vi.doMock('@/lib/shared/job-control', () => ({ runGates: runGatesMock, jobsPausedResult: runGatesMock }));
      vi.doMock('@/lib/usage/resolve-provider', () => ({ checkCliStartGate: checkCliStartGateMock }));

      const mod = await import('@/app/api/agents/[agentId]/run/route');
      insertAgent();
      const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'do something' }),
      });
      const res = await mod.POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.code).toBe('dirty_worktree');
      expect(data.detail).toContain('38');
      expect(data.detail).toContain('20');
      expect(startJobMock).not.toHaveBeenCalled();
    });

    it('does not block when threshold is 0 (disabled)', async () => {
      // settingsMock already has dirty_worktree_block_threshold: 0 from beforeEach
      insertAgent();
      const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'do something' }),
      });
      const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
      expect(res.status).toBe(200);
    });
  });

  describe('doc_paths', () => {
    it('prepends doc file content before skills in the prompt', async () => {
      const projDir = mkdtempSync(join(tmpdir(), 'tamtam-docpath-'));
      try {
        writeFileSync(join(projDir, 'NOTES.md'), 'PROJECT NOTES CONTENT');
        resolveProjectPathMock.mockReturnValue(projDir);
        insertAgent({ docPaths: '["NOTES.md"]' });

        const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
          method: 'POST',
          body: JSON.stringify({ prompt: 'do task' }),
        });
        await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

        const [, , fullPrompt] = startJobMock.mock.calls[0];
        expect(fullPrompt).toContain('PROJECT NOTES CONTENT');
        expect(fullPrompt).toContain('## NOTES.md');
        // doc content must appear before the task prompt
        expect(fullPrompt.indexOf('PROJECT NOTES CONTENT')).toBeLessThan(fullPrompt.indexOf('do task'));
      } finally {
        rmSync(projDir, { recursive: true, force: true });
      }
    });

    it('silently skips doc paths whose file does not exist', async () => {
      insertAgent({ docPaths: '["nonexistent.md"]' });

      const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'do task' }),
      });
      const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
      expect(res.status).toBe(200);

      const [, , fullPrompt] = startJobMock.mock.calls[0];
      expect(fullPrompt).toContain('do task');
      expect(fullPrompt).not.toContain('nonexistent');
    });

    it('blocks path traversal outside the project root', async () => {
      const projDir = mkdtempSync(join(tmpdir(), 'tamtam-docpath-'));
      try {
        resolveProjectPathMock.mockReturnValue(projDir);
        insertAgent({ docPaths: '["../../../etc/passwd"]' });

        const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
          method: 'POST',
          body: JSON.stringify({ prompt: 'do task' }),
        });
        const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
        expect(res.status).toBe(200);

        const [, , fullPrompt] = startJobMock.mock.calls[0];
        // traversal path is blocked — no /etc/passwd content should appear
        expect(fullPrompt).not.toContain('root:');
        expect(fullPrompt).not.toContain('etc/passwd');
      } finally {
        rmSync(projDir, { recursive: true, force: true });
      }
    });

    it('records resolved docs in contextMeta', async () => {
      const projDir = mkdtempSync(join(tmpdir(), 'tamtam-docpath-'));
      try {
        writeFileSync(join(projDir, 'GUIDE.md'), 'guide content');
        resolveProjectPathMock.mockReturnValue(projDir);
        insertAgent({ docPaths: '["GUIDE.md"]' });

        const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
          method: 'POST',
          body: JSON.stringify({ prompt: 'task' }),
        });
        await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

        const createArgs = createJobMock.mock.calls[0];
        const contextMeta = JSON.parse(createArgs[5]);
        expect(contextMeta.docs).toHaveLength(1);
        expect(contextMeta.docs[0].name).toBe('GUIDE.md');
        expect(contextMeta.docs[0].path).toBe('GUIDE.md');
      } finally {
        rmSync(projDir, { recursive: true, force: true });
      }
    });
  });
});

describe('POST /api/agents/{agentId}/run weekly quota gating', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let POST: any;
  let startJobMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let tempSkillsDir: string;
  let snapshots: Map<CliProvider, QuotaSnapshot | null>;

  const now = Date.now() / 1000;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/usage/resolve-provider');
    testDb = createTestDb();
    tempSkillsDir = mkdtempSync(join(tmpdir(), 'tamtam-agent-run-weekly-test-'));

    testDb.db.insert(schema.agents).values({
      id: 'agent-123',
      name: 'Test Agent',
      project: 'proj1',
      skillIds: '[]',
      model: 'sonnet',
      prompt: 'do something',
      schedule: null,
      runner: 'pm2',
      enabled: true,
      provider: 'claude',
      createdAt: now,
      updatedAt: now,
    }).run();

    startJobMock = vi.fn().mockResolvedValue(12345);
    createJobMock = vi.fn().mockImplementation(() => makeJob());
    updateJobMock = vi.fn();

    snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', {
        provider: 'claude',
        fiveHour: { utilization: 24, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 99, resetsAt: null, msUntilReset: null },
        sevenDaySonnet: { utilization: 100, resetsAt: null, msUntilReset: null },
        sevenDayOpus: null,
        fetchedAt: 0,
        stale: false,
      }],
      ['codex', {
        provider: 'codex',
        fiveHour: { utilization: 97, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 10, resetsAt: null, msUntilReset: null },
        fetchedAt: 0,
        stale: false,
      }],
    ]);

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/agents/pending-agent-run', () => ({
      enqueueAgentRun: vi.fn(),
      tryClaimAgentStartSlot: vi.fn().mockReturnValue({ ok: true }),
      releaseAgentStartSlot: vi.fn(),
      drainNextAgentRun: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/agents/queued-agent-runs', () => ({
      enqueueQueuedAgentRun: vi.fn(),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({
      getPendingRelease: vi.fn().mockReturnValue(false),
      drainPendingRelease: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ claudeBin: 'claude', logDir: '/tmp/logs' }),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
      listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn().mockResolvedValue('done'),
      markDone: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      startJob: startJobMock,
    }));
    vi.doMock('@/lib/skills/skills', () => ({
      SKILLS_DIR: tempSkillsDir,
      DATA_SKILLS_DIR: join(tempSkillsDir, 'data-skills'),
    }));
    vi.doMock('@/lib/agents/agent-memory', () => ({
      getAgentMemoryDir: vi.fn().mockReturnValue('/tmp/tamtam-memory'),
      ensureAgentMemoryDir: vi.fn(),
      getAgentMemoryPath: vi.fn().mockReturnValue('/tmp/tamtam-memory/proj1/Test Agent.md'),
      readAgentMemory: vi.fn().mockReturnValue(null),
      buildMemoryBlock: vi.fn().mockReturnValue(''),
    }));
    vi.doMock('@/lib/shared/config', () => ({
      withBasePrompt: (p: string) => p,
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getSettings: vi.fn(() => ({
        workspace_path: '',
        github_owner: '',
        claude_bin: 'claude',
        log_dir: '/tmp/logs',
        cli_enabled_providers: ['claude', 'codex'],
        claude_provider: 'claude',
        budget_block_at_pct: 95,
        budget_block_runs_enabled: true,
        cli_bin_claude: '',
        cli_bin_codex: '',
        cli_bin_gemini: '',
        cli_bin_lmstudio: '',
        frequency: '1h',
        daytime: false,
        weekends: false,
        launchagent_prefix: 'com.tamtam',
        base_prompt: '',
        permission_mode: 'bypassPermissions',
        dirty_worktree_block_threshold: 0,
      })),
    }));
    vi.doMock('@/lib/shared/job-control', () => ({
      runGates: vi.fn().mockReturnValue(null),
      jobsPausedResult: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/git/dirty-worktree', () => ({
      getDirtyFileCount: vi.fn().mockResolvedValue(0),
    }));
    vi.doMock('@/lib/usage/quota', () => ({
      getQuotaSnapshots: vi.fn(() => Promise.resolve(snapshots)),
    }));

    const mod = await import('@/app/api/agents/[agentId]/run/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempSkillsDir, { recursive: true, force: true });
  });

  it('does not 429 a manual agent run when only weekly quota is hot', async () => {
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(200);
    expect(startJobMock).toHaveBeenCalledOnce();
    expect(createJobMock.mock.results[0]?.value.provider).toBe('claude');
  });

  it('returns 429 when a sibling quota-aware provider is missing and the known provider is over the hard cap', async () => {
    snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', {
        provider: 'claude',
        fiveHour: { utilization: 99, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 10, resetsAt: null, msUntilReset: null },
        fetchedAt: 0,
        stale: false,
      }],
      ['codex', null],
    ]);
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();
    expect(res.status).toBe(429);
    expect(data.code).toBe('providers_over_budget');
    expect(data.detail).toContain('All enabled CLI providers are over budget');
    expect(startJobMock).not.toHaveBeenCalled();
  });
});
