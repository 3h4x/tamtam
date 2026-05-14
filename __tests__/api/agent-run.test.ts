import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import type { CliProvider } from '@/lib/usage/cli-providers';
import type { QuotaSnapshot } from '@/lib/usage/quota-types';

// ------------------------------------------------------------------
// Hoisted mock state — shared across all tests; replaces the per-test
// `vi.resetModules()` + `vi.doMock()` pattern that previously rebuilt the
// whole module graph (and re-spawned git) for every test (~50ms each).
// ------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  return {
    db: null as unknown,
    startJob: vi.fn(),
    resolveProjectPath: vi.fn(),
    createJob: vi.fn(),
    updateJob: vi.fn(),
    listJobs: vi.fn(),
    probeJobStatus: vi.fn(),
    markDone: vi.fn(),
    getJob: vi.fn(),
    shellRun: vi.fn(),
    runGates: vi.fn(),
    enqueueAgentRun: vi.fn(),
    enqueueQueuedAgentRun: vi.fn(),
    drainNextAgentRun: vi.fn(),
    tryClaimAgentStartSlot: vi.fn(),
    checkCliStartGate: vi.fn(),
    findBlockingRunningJob: vi.fn(),
    getLock: vi.fn(),
    isLockOwnedByActiveRelease: vi.fn(),
    getPendingRelease: vi.fn(),
    drainPendingRelease: vi.fn(),
    isProjectPaused: vi.fn(),
    retrieveAgentContextDetailed: vi.fn(),
    getDirtyFileCount: vi.fn(),
    getQuotaSnapshots: vi.fn(),
    getSettings: vi.fn(),
    getImproveConfig: vi.fn(),
    getProjectTestConfig: vi.fn(),
    skillsDir: '',
    dataSkillsDir: '',
    // The first describe block fully mocks `checkCliStartGate`, but the
    // second describe ("weekly quota gating") must let the *real*
    // `resolve-provider` module branch off `getQuotaSnapshots`. This flag
    // toggles between the two.
    useRealResolveProvider: false,
  };
});

// ------------------------------------------------------------------
// Top-level mocks (resolved at module-graph load time, ONCE per worker).
// ------------------------------------------------------------------
vi.mock('@/lib/db', () => ({
  get db() { return mocks.db; },
  schema,
}));

vi.mock('workflow/api', () => ({
  start: async (fn: (p: unknown) => Promise<void>, args: unknown[]) => {
    await fn(args[0]);
  },
}));

vi.mock('@/lib/agents/pending-agent-run', () => ({
  enqueueAgentRun: (...a: unknown[]) => mocks.enqueueAgentRun(...a),
  tryClaimAgentStartSlot: (...a: unknown[]) => mocks.tryClaimAgentStartSlot(...a),
  releaseAgentStartSlot: vi.fn(),
  drainNextAgentRun: (...a: unknown[]) => mocks.drainNextAgentRun(...a),
}));

vi.mock('@/lib/agents/queued-agent-runs', () => ({
  enqueueQueuedAgentRun: (...a: unknown[]) => mocks.enqueueQueuedAgentRun(...a),
}));

vi.mock('@/lib/pipeline/pipeline-lock', () => ({
  getLock: (...a: unknown[]) => mocks.getLock(...a),
  isLockOwnedByActiveRelease: (...a: unknown[]) => mocks.isLockOwnedByActiveRelease(...a),
}));

vi.mock('@/lib/pipeline/pending-release', () => ({
  getPendingRelease: (...a: unknown[]) => mocks.getPendingRelease(...a),
  drainPendingRelease: (...a: unknown[]) => mocks.drainPendingRelease(...a),
}));

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: (...a: unknown[]) => mocks.resolveProjectPath(...a),
}));

vi.mock('@/lib/shared/shell', () => ({
  exec: (...a: unknown[]) => mocks.shellRun(...a),
}));

vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: (...a: unknown[]) => mocks.getImproveConfig(...a),
  getProjectTestConfig: (...a: unknown[]) => mocks.getProjectTestConfig(...a),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  createJob: (...a: unknown[]) => mocks.createJob(...a),
  updateJob: (...a: unknown[]) => mocks.updateJob(...a),
  listJobs: (...a: unknown[]) => mocks.listJobs(...a),
  probeJobStatus: (...a: unknown[]) => mocks.probeJobStatus(...a),
  markDone: (...a: unknown[]) => mocks.markDone(...a),
  getJob: (...a: unknown[]) => mocks.getJob(...a),
}));

vi.mock('@/lib/jobs/project-active-job', () => ({
  findBlockingRunningJob: (...a: unknown[]) => mocks.findBlockingRunningJob(...a),
}));

vi.mock('@/lib/jobs/pm2-jobs', () => ({
  startJob: (...a: unknown[]) => mocks.startJob(...a),
}));

vi.mock('@/lib/skills/skills', () => ({
  get SKILLS_DIR() { return mocks.skillsDir; },
  get DATA_SKILLS_DIR() { return mocks.dataSkillsDir; },
}));

vi.mock('@/lib/agents/agent-memory', () => ({
  getAgentMemoryDir: vi.fn().mockReturnValue('/tmp/tamtam-memory'),
  ensureAgentMemoryDir: vi.fn(),
  getAgentMemoryPath: vi.fn().mockReturnValue('/tmp/tamtam-memory/proj1/Test Agent.md'),
  readAgentMemory: vi.fn().mockReturnValue(null),
  buildMemoryBlock: vi.fn().mockReturnValue(''),
}));

vi.mock('@/lib/shared/config', () => ({
  withBasePrompt: (p: string) => p,
  getPermissionModeFlag: () => '--dangerously-skip-permissions',
  getSettings: (...a: unknown[]) => mocks.getSettings(...a),
}));

vi.mock('@/lib/shared/job-control', () => ({
  runGates: (...a: unknown[]) => mocks.runGates(...a),
  jobsPausedResult: (...a: unknown[]) => mocks.runGates(...a),
}));

// `checkCliStartGate` toggles between the explicit mock (first describe) and
// the real implementation (second describe — to exercise the quota path).
vi.mock('@/lib/usage/resolve-provider', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/usage/resolve-provider')>();
  return {
    ...real,
    checkCliStartGate: (...a: Parameters<typeof real.checkCliStartGate>) =>
      mocks.useRealResolveProvider
        ? real.checkCliStartGate(...a)
        : (mocks.checkCliStartGate as typeof real.checkCliStartGate)(...a),
  };
});

vi.mock('@/lib/agents/retrieval/retriever', () => ({
  retrieveAgentContextDetailed: (...a: unknown[]) => mocks.retrieveAgentContextDetailed(...a),
}));

vi.mock('@/lib/git/dirty-worktree', () => ({
  getDirtyFileCount: (...a: unknown[]) => mocks.getDirtyFileCount(...a),
}));

vi.mock('@/lib/shared/enabled-projects', () => ({
  isProjectArchived: vi.fn().mockReturnValue(false),
  isProjectPaused: (...a: unknown[]) => mocks.isProjectPaused(...a),
}));

// Avoid spawning real `git` for file-agent loading on every test (~10–30ms).
vi.mock('@/lib/git/git-branch', () => ({
  getBranchContext: vi.fn().mockReturnValue({
    isDefaultBranch: true,
    currentBranch: 'master',
    defaultBranch: 'master',
  }),
  getDefaultBranchSync: vi.fn().mockReturnValue('master'),
  gitLsTreeSync: vi.fn().mockReturnValue([]),
  gitShowSync: vi.fn().mockReturnValue(null),
}));

// `getQuotaSnapshots` is only consulted by the real `resolve-provider` path
// in the second describe; route-import time still reads it but the value
// doesn't matter unless `useRealResolveProvider` is true.
vi.mock('@/lib/usage/quota', () => ({
  getQuotaSnapshots: (...a: unknown[]) => mocks.getQuotaSnapshots(...a),
}));

// Top-level imports are safe now that mocks are module-scope.
let POST: typeof import('@/app/api/agents/[agentId]/run/route').POST;

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
      model text NOT NULL DEFAULT 'normal',
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
    CREATE TABLE IF NOT EXISTS skills (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      content text NOT NULL DEFAULT '',
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
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
  let sharedHandle: TestDbHandle;
  let tempSkillsDir: string;
  let logDirMock: string;
  let settingsMock: Record<string, unknown>;

  const now = Date.now() / 1000;

  async function insertAgent(overrides: Record<string, unknown> = {}) {
    await sharedHandle.db
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
      });
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

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
    mocks.db = sharedHandle.db;
    // One shared skills tempdir per suite (avoids per-test mkdtemp/rmSync churn).
    // Tests that write into it explicitly clean up the inner `docs/` subtree so
    // file-skill content does not leak between cases.
    tempSkillsDir = mkdtempSync(join(tmpdir(), 'tamtam-agent-run-test-'));
    mocks.skillsDir = tempSkillsDir;
    mocks.dataSkillsDir = join(tempSkillsDir, 'data-skills');
    const mod = await import('@/app/api/agents/[agentId]/run/route');
    POST = mod.POST;
  });

  afterAll(async () => {
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
    rmSync(tempSkillsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    mocks.useRealResolveProvider = false;
    mocks.db = sharedHandle.db;
    await Promise.all([
      sharedHandle.db.execute(sql.raw('DELETE FROM agents')),
      sharedHandle.db.execute(sql.raw('DELETE FROM skills')),
    ]);
    logDirMock = '/tmp/logs';

    // Reset every shared mock and reinstall defaults.
    mocks.startJob.mockReset().mockResolvedValue(12345);
    mocks.resolveProjectPath.mockReset().mockReturnValue('/path/to/proj');
    // `createJob` returns a stable job object so the workflow can mutate it
    // (contextMeta, finishedAt, exitCode) and tests can observe the result via
    // either `getJob` (which returns the same instance the route created) or
    // by reading the job object stored in `mocks.createJob.mock.results`.
    mocks.createJob.mockReset().mockImplementation(() => makeJob());
    // `getJob` returns whatever `createJob` most recently returned so workflow
    // mutations land on the same job object the test holds a reference to.
    mocks.getJob.mockReset().mockImplementation(() => {
      const results = mocks.createJob.mock.results;
      const last = results[results.length - 1];
      return last && last.type === 'return' ? last.value : makeJob();
    });
    mocks.updateJob.mockReset();
    mocks.listJobs.mockReset().mockReturnValue([]);
    mocks.probeJobStatus.mockReset().mockResolvedValue('done');
    mocks.markDone.mockReset().mockResolvedValue(undefined);
    mocks.shellRun.mockReset().mockImplementation(async (cmd: string, args: string[]) => {
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
    mocks.runGates.mockReset().mockReturnValue(null);
    mocks.enqueueAgentRun.mockReset();
    mocks.enqueueQueuedAgentRun.mockReset();
    mocks.drainNextAgentRun.mockReset().mockResolvedValue(undefined);
    mocks.tryClaimAgentStartSlot.mockReset().mockReturnValue({ ok: true });
    mocks.checkCliStartGate.mockReset().mockResolvedValue({ ok: true, provider: 'claude' });
    mocks.findBlockingRunningJob.mockReset().mockResolvedValue(null);
    mocks.getLock.mockReset().mockReturnValue(null);
    mocks.isLockOwnedByActiveRelease.mockReset().mockReturnValue(false);
    mocks.getPendingRelease.mockReset().mockReturnValue(false);
    mocks.drainPendingRelease.mockReset().mockResolvedValue(undefined);
    mocks.isProjectPaused.mockReset().mockReturnValue(false);
    mocks.getDirtyFileCount.mockReset().mockResolvedValue(0);
    mocks.retrieveAgentContextDetailed.mockReset().mockResolvedValue({
      block: '## Retrieved Context\ncached context',
      diagnostics: {
        status: 'ok',
        reason: 'results',
        corpusChunkCount: 3,
        retrievedCount: 1,
        acceptedCount: 1,
        topScore: 0.9,
        scoreThreshold: 0.8,
      },
    });
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
    mocks.getSettings.mockReset().mockImplementation(() => settingsMock);
    mocks.getImproveConfig.mockReset().mockImplementation(() => ({ claudeBin: 'claude', logDir: logDirMock }));
    mocks.getProjectTestConfig.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    // Only the few persona/file-skill tests populate this; cheaper than a full
    // mkdtemp/rmSync per test.
    rmSync(join(tempSkillsDir, 'docs'), { recursive: true, force: true });
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
    await insertAgent();
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
    await insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: '   ' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 if project path cannot be resolved', async () => {
    await insertAgent();
    mocks.resolveProjectPath.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('proj1');
  });

  it('returns 409 when project is paused', async () => {
    await insertAgent();
    mocks.isProjectPaused.mockReturnValue(true);
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('project_paused');
    expect(data.detail).toContain('paused');
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('starts job and returns job info', async () => {
    await insertAgent();
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
    expect(mocks.drainNextAgentRun).toHaveBeenCalledWith('proj1');
  });

  it('keeps the Codex shim on the command line and forwards CODEX_BIN via env', async () => {
    await insertAgent({ provider: 'codex' });
    mocks.checkCliStartGate.mockResolvedValue({ ok: true, provider: 'codex' });
    settingsMock.cli_bin_codex = '/custom/codex';

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    expect(mocks.startJob).toHaveBeenCalledWith(
      'test-job-id',
      expect.stringContaining('/scripts/codex-shim.js'),
      expect.any(String),
      '/path/to/proj',
      { env: { CODEX_BIN: '/custom/codex' } },
    );
  });

  it('returns 429 when every enabled provider is over budget', async () => {
    await insertAgent();
    mocks.checkCliStartGate.mockResolvedValue({
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
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('returns a coded 409 for scheduled runs when jobs are paused so queue drains can preserve the head', async () => {
    await insertAgent({ schedule: '1h' });
    mocks.checkCliStartGate.mockResolvedValue({
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
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('rejects scheduled triggers for disabled agents before starting work', async () => {
    await insertAgent({ enabled: false, schedule: '1h' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('is disabled');
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('rejects scheduled triggers for agents without schedules before starting work', async () => {
    await insertAgent({ schedule: null });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('has no schedule');
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('rejects scheduled triggers when the agent is already running', async () => {
    await insertAgent({ schedule: '1h' });
    mocks.listJobs.mockReturnValue([makeJob({ id: 'job-1', finishedAt: null })]);
    mocks.probeJobStatus.mockResolvedValue('running');
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('already running');
    expect(mocks.startJob).not.toHaveBeenCalled();
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('queues the run when a different agent is already running on the project', async () => {
    await insertAgent({ schedule: '1h' });
    mocks.listJobs.mockReturnValue([
      makeJob({ id: 'job-other', kind: 'agent:Other Agent', finishedAt: null }),
    ]);
    mocks.probeJobStatus.mockResolvedValue('running');
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
    expect(mocks.startJob).not.toHaveBeenCalled();
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueQueuedAgentRun).not.toHaveBeenCalled();
    const [project, entry] = mocks.enqueueAgentRun.mock.calls[0];
    expect(project).toBe('proj1');
    expect(entry.agentId).toBe('agent-123');
    expect(entry.agentName).toBe('Test Agent');
    expect(entry.triggeredBy).toBe('schedule');
    expect(entry.prompt).toBe('do something');
  });

  it('returns 409 project_busy when a non-agent project job is already running', async () => {
    await insertAgent({ schedule: '1h' });
    mocks.findBlockingRunningJob.mockResolvedValue(makeJob({ id: 'run-123', kind: 'run' }));
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
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('does not let manage-agents metadata bypass a non-agent project blocker', async () => {
    await insertAgent({
      name: 'manage-agents',
      skillIds: '["agent-manage-agents"]',
      schedule: '1h',
    });
    mocks.findBlockingRunningJob.mockResolvedValue(makeJob({ id: 'run-123', kind: 'run' }));

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'audit the agent fleet' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.code).toBe('project_busy');
    expect(data.blockingJobId).toBe('run-123');
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('releases the starting slot after a pre-start failure so same-agent retries are not stranded', async () => {
    await insertAgent({ schedule: '1h' });
    const pendingStart = deferred<void>();
    mocks.tryClaimAgentStartSlot
      .mockReturnValueOnce({ ok: true })
      .mockReturnValueOnce({ ok: false, runningAgent: 'Test Agent' });
    mocks.startJob.mockImplementationOnce(async () => {
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
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    expect(mocks.drainNextAgentRun).toHaveBeenCalledWith('proj1');
  });

  it('drains the queued different agent after a pre-start failure by the slot holder', async () => {
    await insertAgent({ schedule: '1h' });
    const pendingStart = deferred<void>();
    mocks.tryClaimAgentStartSlot.mockReturnValueOnce({ ok: true });
    mocks.startJob.mockImplementationOnce(async () => {
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

    mocks.tryClaimAgentStartSlot.mockReturnValueOnce({ ok: false, runningAgent: 'Other Agent' });
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
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.drainNextAgentRun).toHaveBeenCalledWith('proj1');
  });

  it('does not queue when a different agent for the project is no longer actually running', async () => {
    await insertAgent({ schedule: '1h' });
    mocks.listJobs.mockReturnValue([
      makeJob({ id: 'job-stale', kind: 'agent:Stale Agent', finishedAt: null }),
    ]);
    mocks.probeJobStatus.mockResolvedValue('done');
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(200);
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    expect(mocks.startJob).toHaveBeenCalledTimes(1);
  });

  it('does not let manage-agents metadata run alongside a different agent on the same project', async () => {
    await insertAgent({
      name: 'manage-agents',
      skillIds: '["agent-manage-agents"]',
      schedule: '1h',
    });
    mocks.listJobs.mockReturnValue([
      makeJob({ id: 'job-other', kind: 'agent:Other Agent', finishedAt: null }),
    ]);
    mocks.probeJobStatus.mockResolvedValue('running');

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'audit the agent fleet' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(202);
    expect(data.status).toBe('queued');
    expect(data.blockingJobId).toBe('job-other');
    expect(mocks.startJob).not.toHaveBeenCalled();
    expect(mocks.enqueueAgentRun).toHaveBeenCalledOnce();
    expect(mocks.tryClaimAgentStartSlot).not.toHaveBeenCalled();
  });

  it('ignores malformed running-job rows whose kind is not a string', async () => {
    await insertAgent({ schedule: '1h' });
    mocks.listJobs.mockReturnValue([
      makeJob({ id: 'job-bad', kind: null, finishedAt: null }),
    ]);
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    expect(mocks.startJob).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('queues in the DB-backed release-lock queue before checking running agents', async () => {
    await insertAgent({ schedule: '1h' });
    mocks.isLockOwnedByActiveRelease.mockReturnValue(true);
    mocks.getLock.mockReturnValue({ project: 'proj1', lockedByJobId: 'release-1' });
    mocks.listJobs.mockReturnValue([
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
    expect(mocks.enqueueQueuedAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    expect(mocks.probeJobStatus).not.toHaveBeenCalled();
  });

  it('drains an older pending release before allowing a fresh agent start', async () => {
    await insertAgent({ schedule: '1h' });
    mocks.getPendingRelease
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    expect(mocks.drainPendingRelease).toHaveBeenCalledWith('proj1');
    expect(mocks.startJob).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueQueuedAgentRun).not.toHaveBeenCalled();
  });

  it('queues behind a still-pending release after retrying the drain', async () => {
    await insertAgent({ schedule: '1h' });
    mocks.getPendingRelease.mockReturnValue(true);
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
    expect(mocks.drainPendingRelease).toHaveBeenCalledWith('proj1');
    expect(mocks.enqueueQueuedAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('does not claim a run was queued when persisting the release-lock row fails', async () => {
    await insertAgent({ schedule: '1h' });
    mocks.isLockOwnedByActiveRelease.mockReturnValue(true);
    mocks.getLock.mockReturnValue({ project: 'proj1', lockedByJobId: 'release-1' });
    mocks.enqueueQueuedAgentRun.mockImplementation(() => {
      throw new Error('relation "queued_agent_runs" does not exist');
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
    expect(mocks.startJob).not.toHaveBeenCalled();
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('returns the global pause conflict when scheduled work reaches the route while jobs are paused', async () => {
    await insertAgent({ schedule: '1h' });
    mocks.checkCliStartGate.mockResolvedValue({
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
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('calls startJob with correct args', async () => {
    await insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run tests' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(mocks.startJob).toHaveBeenCalledOnce();
    const [, cmd, fullPrompt, projPath] = mocks.startJob.mock.calls[0];
    expect(cmd).toContain('claude');
    expect(cmd).toContain('--model normal');
    expect(fullPrompt).toContain('run tests');
    expect(projPath).toBe('/path/to/proj');
  });

  it('treats the agent provider as required when one is configured', async () => {
    await insertAgent({ provider: 'claude' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run tests' }),
    });

    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(mocks.checkCliStartGate).toHaveBeenCalledWith('start an agent run', {
      preferred: 'claude',
      strictPreferred: true,
      requestedModel: 'normal',
      respectJobsPaused: false,
    });
  });

  it('does not mislabel a disabled required provider as jobs_paused', async () => {
    await insertAgent({ provider: 'claude' });
    mocks.checkCliStartGate.mockResolvedValue({
      ok: false,
      status: 409,
      detail: "Selected provider 'claude' is not enabled. Pick another provider or enable it in Settings → CLI.",
    });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run tests' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.code).toBeUndefined();
    expect(data.detail).toContain("Selected provider 'claude' is not enabled");
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('sanitizes an invalid stored model before building the command', async () => {
    await insertAgent({ model: 'smart --resume injected' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run tests' }),
    });

    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, cmd] = mocks.startJob.mock.calls[0];
    expect(cmd).toContain('--model normal');
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('injected');
  });

  it('calls updateJob after startJob', async () => {
    await insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do it' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(mocks.updateJob).toHaveBeenCalled();
  });

  it('composes skills into system prompt', async () => {
    await sharedHandle.db
      .insert(schema.skills)
      .values({
        id: 'skill-1',
        name: 'My Skill',
        description: 'desc',
        content: 'Skill instructions here',
        createdAt: now,
        updatedAt: now,
      });
    await insertAgent({ skillIds: '["skill-1"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task prompt' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).toContain('## My Skill');
    expect(fullPrompt).toContain('Skill instructions here');
    expect(fullPrompt).toContain('task prompt');
  });

  it('does not prepend skill content when agent has no skills', async () => {
    await insertAgent({ skillIds: '[]' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task prompt' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).toContain('task prompt');
    expect(fullPrompt).not.toContain('## My Skill');
  });

  it('returns 500 if startJob throws', async () => {
    await insertAgent();
    mocks.startJob.mockRejectedValue(new Error('pm2 not available'));
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('pm2 not available');
    // Job must be persisted as failed so it doesn't stay "running" in the DB
    expect(mocks.updateJob).toHaveBeenCalled();
    const savedJob = mocks.updateJob.mock.calls[mocks.updateJob.mock.calls.length - 1][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });

  it('prepends file-based persona content when skillIds contains persona:<path>', async () => {
    const docsDir = join(tempSkillsDir, 'docs', 'skills', 'engineering-team');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'senior-fullstack.md'), 'FULLSTACK-PERSONA-BODY');

    await insertAgent({ skillIds: '["persona:engineering-team/senior-fullstack"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'build it' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).toContain('FULLSTACK-PERSONA-BODY');
    expect(fullPrompt).toContain('build it');
  });

  it('mixes DB skills and file-based personas in skillIds', async () => {
    const docsDir = join(tempSkillsDir, 'docs', 'skills');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'reviewer.md'), 'REVIEWER-FILE-CONTENT');

    await sharedHandle.db
      .insert(schema.skills)
      .values({ id: 'skill-1', name: 'DB Skill', description: '', content: 'DB-SKILL-BODY', createdAt: now, updatedAt: now });
    await insertAgent({ skillIds: '["skill-1","persona:reviewer"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).toContain('DB-SKILL-BODY');
    expect(fullPrompt).toContain('REVIEWER-FILE-CONTENT');
    expect(fullPrompt).toContain('task');
  });

  it('omits the prerequisite block when the agent has no prerequisiteCommand', async () => {
    await insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const [, , fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).not.toContain('## Prerequisite Output');
    expect(fullPrompt).not.toContain('Exit code:');
  });

  it('runs the prerequisite command and prepends its output to the prompt', async () => {
    mkdirSync('/tmp/logs', { recursive: true });
    mocks.resolveProjectPath.mockReturnValue('/tmp');

    await insertAgent({ prerequisiteCommand: 'echo TAMTAM_PREREQ_MARKER' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'analyze the output above' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).toContain('## Prerequisite Output');
    expect(fullPrompt).toContain('echo TAMTAM_PREREQ_MARKER');
    expect(fullPrompt).toContain('Exit code: 0');
    expect(fullPrompt).toContain('TAMTAM_PREREQ_MARKER');
    expect(fullPrompt).toContain('analyze the output above');
  });

  it('redacts prerequisite command secrets in the prompt, artifact, and context metadata', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'tamtam-agent-prereq-redaction-'));
    logDirMock = join(tempRoot, 'logs');
    mocks.resolveProjectPath.mockReturnValue('/tmp');
    mocks.shellRun.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'bash' && args[1] === 'SERVICE_TOKEN=runtime-secret-value curl https://user:supersecret@example.com/path') {
        return {
          stdout: 'token=ghp_abcdefghijklmnopqrstuvwxyz123456\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      if (cmd === 'git' && args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    try {
      await insertAgent({ prerequisiteCommand: 'SERVICE_TOKEN=runtime-secret-value curl https://user:supersecret@example.com/path' });
      const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'inspect prereq' }),
      });
      await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

      const [, , fullPrompt] = mocks.startJob.mock.calls[0];
      expect(fullPrompt).toContain('SERVICE_TOKEN=[REDACTED] curl https://user:[REDACTED]@example.com/path');
      expect(fullPrompt).not.toContain('runtime-secret-value');
      expect(fullPrompt).not.toContain('supersecret');

      const artifactPath = join(logDirMock, 'test-job-id.prereq.txt');
      const artifact = readFileSync(artifactPath, 'utf-8');
      expect(artifact).toContain('command: SERVICE_TOKEN=[REDACTED] curl https://user:[REDACTED]@example.com/path');
      expect(artifact).not.toContain('runtime-secret-value');
      expect(artifact).not.toContain('supersecret');

      const updatedJob = mocks.updateJob.mock.calls.at(-1)?.[0];
      expect(updatedJob?.contextMeta).toBeTruthy();
      const contextMeta = JSON.parse(updatedJob.contextMeta);
      expect(contextMeta.prerequisite.command).toBe('SERVICE_TOKEN=[REDACTED] curl https://user:[REDACTED]@example.com/path');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('injects the trusted-only issue prerequisite for issue-cruncher agents without an explicit prerequisiteCommand', async () => {
    await insertAgent({ name: 'Issue Cruncher', skillIds: '["agent-issue-cruncher"]' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'pick the next issue' }),
    });

    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(mocks.shellRun).toHaveBeenCalledWith(
      'bash',
      ['-c', 'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?trusted_only=1"'],
      expect.objectContaining({ cwd: '/path/to/proj' }),
    );
    const [, , fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).toContain('## Prerequisite Output');
    expect(fullPrompt).toContain('trusted_only=1');
    expect(fullPrompt).toContain('Trusted issue');
  });

  it('does not re-inject the issue-cruncher prerequisite after an explicit clear', async () => {
    await insertAgent({
      name: 'Issue Cruncher',
      skillIds: '["agent-issue-cruncher"]',
      prerequisiteCommand: '',
    });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'pick the next issue' }),
    });

    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(mocks.shellRun).not.toHaveBeenCalledWith(
      'bash',
      ['-c', 'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?trusted_only=1"'],
      expect.anything(),
    );
    const [, , fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).not.toContain('## Prerequisite Output');
    expect(fullPrompt).not.toContain('trusted_only=1');
  });

  it('creates the log directory before writing the prerequisite artifact', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'tamtam-agent-prereq-logdir-'));
    logDirMock = join(tempRoot, 'missing-logs');
    try {
      await insertAgent({ prerequisiteCommand: 'echo TAMTAM_PREREQ_MARKER' });
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
    mocks.resolveProjectPath.mockReturnValue('/tmp');

    await insertAgent({ prerequisiteCommand: 'exit 7' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'inspect failure' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    const [, , fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).toContain('## Prerequisite Output');
    expect(fullPrompt).toContain('Exit code: 7');
  });

  it('creates the job row before the prerequisite runs so it is visible in the UI', async () => {
    const prereq = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    mocks.shellRun.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      if (cmd === 'git' && args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 };
      if (cmd === 'bash' && args[1] === 'sleep 40') return prereq.promise;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await insertAgent({ prerequisiteCommand: 'sleep 40' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'inspect later' }),
    });

    const pending = POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    await vi.waitFor(() => {
      expect(mocks.createJob).toHaveBeenCalledOnce();
      expect(mocks.shellRun).toHaveBeenCalledWith('bash', ['-c', 'sleep 40'], expect.objectContaining({ cwd: '/path/to/proj' }));
    }, { interval: 2, timeout: 1000 });
    expect(mocks.startJob).not.toHaveBeenCalled();

    prereq.resolve({ stdout: 'done\n', stderr: '', exitCode: 0 });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(mocks.createJob).toHaveBeenCalledOnce();
    expect(mocks.startJob).toHaveBeenCalledOnce();
    expect(mocks.drainNextAgentRun).toHaveBeenCalledWith('proj1');
  });

  it('cancels a db-backed prerequisite run before the agent spawn begins', async () => {
    // Workflow refactor: the route no longer surfaces a "cancelled" response
    // status because `start()` resolves with a Run handle, not the final job
    // disposition. Cancellation is now a workflow side-effect: the prerequisite
    // step aborts via the signal, marks the job done with exit 130, and the
    // start step is never reached. Assertions track those side effects.
    const sharedJob = makeJob();
    mocks.createJob.mockReturnValue(sharedJob);
    const prereq = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    mocks.shellRun.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      if (cmd === 'git' && args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 };
      if (cmd === 'bash' && args[1] === 'sleep 40') return prereq.promise;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await insertAgent({ prerequisiteCommand: 'sleep 40' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'cancel later' }),
    });

    const pending = POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    await vi.waitFor(() => {
      expect(mocks.createJob).toHaveBeenCalledOnce();
      expect(mocks.shellRun).toHaveBeenCalledWith('bash', ['-c', 'sleep 40'], expect.objectContaining({ cwd: '/path/to/proj' }));
    }, { interval: 2, timeout: 1000 });

    const { requestJobCancellation } = await import('@/lib/jobs/cancellation');
    const cancellation = requestJobCancellation(sharedJob.id, 1_000);
    prereq.resolve({ stdout: '', stderr: '', exitCode: 130 });

    await expect(cancellation).resolves.toBe(true);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(mocks.startJob).not.toHaveBeenCalled();
    expect(sharedJob.finishedAt).not.toBeNull();
    expect(sharedJob.exitCode).toBe(130);
  });

  it('re-checks project blockers after a long prerequisite before spawning the agent', async () => {
    // Workflow refactor: the post-prerequisite blocker re-check now happens
    // inside the compose step, not in the route. The route returns the synchronous
    // "started" handle; the workflow then detects the late-arriving blocker,
    // logs it, and marks the job done without spawning the agent. The blocker
    // helper must still be called twice (route admission + workflow re-check).
    const sharedJob = makeJob();
    mocks.createJob.mockReturnValue(sharedJob);
    const prereq = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    mocks.shellRun.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      if (cmd === 'git' && args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 };
      if (cmd === 'bash' && args[1] === 'sleep 40') return prereq.promise;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mocks.findBlockingRunningJob
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeJob({ id: 'run-while-prereq', kind: 'run' }));
    await insertAgent({ prerequisiteCommand: 'sleep 40' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'inspect later' }),
    });

    const pending = POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    await vi.waitFor(() => {
      expect(mocks.createJob).toHaveBeenCalledOnce();
      expect(mocks.shellRun).toHaveBeenCalledWith('bash', ['-c', 'sleep 40'], expect.objectContaining({ cwd: '/path/to/proj' }));
    }, { interval: 2, timeout: 1000 });

    prereq.resolve({ stdout: 'done\n', stderr: '', exitCode: 0 });
    await pending;
    expect(mocks.findBlockingRunningJob).toHaveBeenCalledTimes(2);
    expect(mocks.startJob).not.toHaveBeenCalled();
    expect(sharedJob.finishedAt).not.toBeNull();
    expect(sharedJob.exitCode).toBe(1);
  });

  it('re-checks the post-prerequisite blocker for manage-agents metadata', async () => {
    // Same architectural note as the prior test: the late-arriving blocker
    // is now detected in the compose step, surfaced via job-state mutation
    // rather than a 409 response. The route's response remains "started".
    const sharedJob = makeJob();
    mocks.createJob.mockReturnValue(sharedJob);
    const prereq = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    mocks.shellRun.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      if (cmd === 'git' && args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 };
      if (cmd === 'bash' && args[1] === 'sleep 40') return prereq.promise;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mocks.findBlockingRunningJob
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeJob({ id: 'run-while-prereq', kind: 'run' }));
    await insertAgent({
      name: 'manage-agents',
      skillIds: '["agent-manage-agents"]',
      prerequisiteCommand: 'sleep 40',
    });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'audit the agent fleet' }),
    });

    const pending = POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    await vi.waitFor(() => {
      expect(mocks.createJob).toHaveBeenCalledOnce();
      expect(mocks.shellRun).toHaveBeenCalledWith('bash', ['-c', 'sleep 40'], expect.objectContaining({ cwd: '/path/to/proj' }));
    }, { interval: 2, timeout: 1000 });

    prereq.resolve({ stdout: 'done\n', stderr: '', exitCode: 0 });
    await pending;

    expect(mocks.findBlockingRunningJob).toHaveBeenCalledTimes(2);
    expect(mocks.startJob).not.toHaveBeenCalled();
    expect(sharedJob.finishedAt).not.toBeNull();
    expect(sharedJob.exitCode).toBe(1);
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
      mocks.resolveProjectPath.mockReturnValue(projDir);
      mocks.shellRun.mockImplementation(async (cmd: string, args: string[]) => {
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
        expect(mocks.createJob).toHaveBeenCalledOnce();
        expect(mocks.shellRun).toHaveBeenCalledWith('bash', ['-c', 'sleep 45'], expect.objectContaining({ cwd: projDir }));
      }, { interval: 2, timeout: 1000 });
      expect(mocks.startJob).not.toHaveBeenCalled();

      prereq.resolve({ stdout: 'file done\n', stderr: '', exitCode: 0 });
      const res = await pending;
      expect(res.status).toBe(200);
      expect(mocks.createJob).toHaveBeenCalledOnce();
      expect(mocks.startJob).toHaveBeenCalledOnce();
      expect(mocks.drainNextAgentRun).toHaveBeenCalledWith('proj1');
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('does not let file-agent metadata bypass a non-agent project blocker', async () => {
    const projDir = mkdtempSync(join(tmpdir(), 'tamtam-file-agent-concurrency-'));
    try {
      mkdirSync(join(projDir, '.tamtam', 'agents'), { recursive: true });
      writeFileSync(join(projDir, '.tamtam', 'agents', 'manage-agents.md'), `---
skillIds: ["agent-manage-agents"]
---
File-backed prompt.`);
      mocks.resolveProjectPath.mockReturnValue(projDir);
      mocks.findBlockingRunningJob.mockResolvedValue(makeJob({ id: 'run-123', kind: 'run' }));

      const req = new NextRequest('http://localhost/api/agents/file%3Aproj1%3Amanage-agents/run', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'audit the file-backed fleet' }),
      });

      const res = await POST(req, { params: Promise.resolve({ agentId: 'file:proj1:manage-agents' }) });
      const data = await res.json();

      expect(res.status).toBe(409);
      expect(data.code).toBe('project_busy');
      expect(data.blockingJobId).toBe('run-123');
      expect(mocks.startJob).not.toHaveBeenCalled();
      expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('cancels a file-backed prerequisite run before the agent spawn begins', async () => {
    // See workflow-refactor note on the db-backed cancel test above: the route
    // surface no longer exposes a `data.status === 'cancelled'` field; we
    // assert the cancellation's side-effects on the shared job instead.
    const sharedJob = makeJob();
    mocks.createJob.mockReturnValue(sharedJob);
    const projDir = mkdtempSync(join(tmpdir(), 'tamtam-file-agent-prereq-cancel-'));
    const prereq = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    try {
      mkdirSync(join(projDir, '.tamtam', 'agents'), { recursive: true });
      writeFileSync(join(projDir, '.tamtam', 'agents', 'file-agent.md'), `---
prerequisiteCommand: "sleep 45"
---
File-backed prompt.`);
      mocks.resolveProjectPath.mockReturnValue(projDir);
      mocks.shellRun.mockImplementation(async (cmd: string, args: string[]) => {
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
        expect(mocks.createJob).toHaveBeenCalledOnce();
        expect(mocks.shellRun).toHaveBeenCalledWith('bash', ['-c', 'sleep 45'], expect.objectContaining({ cwd: projDir }));
      }, { interval: 2, timeout: 1000 });

      const { requestJobCancellation } = await import('@/lib/jobs/cancellation');
      const cancellation = requestJobCancellation(sharedJob.id, 1_000);
      prereq.resolve({ stdout: '', stderr: '', exitCode: 130 });

      await expect(cancellation).resolves.toBe(true);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(mocks.startJob).not.toHaveBeenCalled();
      expect(sharedJob.finishedAt).not.toBeNull();
      expect(sharedJob.exitCode).toBe(130);
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('records resolved skills in contextMeta so the terminal toolbar can show chips', async () => {
    // Workflow refactor: skills/docs/baseline are now resolved inside the
    // compose step and written to `job.contextMeta` (which the workflow's
    // start step then persists via `updateJob`). The initial createJob value
    // only carries the agent meta. Assert against the final job state.
    const docsDir = join(tempSkillsDir, 'docs', 'skills', 'engineering-team');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'senior-fullstack.md'), '---\nname: Senior Fullstack\n---\nbody');

    await sharedHandle.db
      .insert(schema.skills)
      .values({ id: 'skill-db', name: 'DB One', description: 'desc', content: 'x', createdAt: now, updatedAt: now });
    await insertAgent({ skillIds: '["skill-db","persona:engineering-team/senior-fullstack"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const createdJob = mocks.createJob.mock.results[0].value;
    expect(createdJob.contextMeta).toBeTruthy();
    const meta = JSON.parse(createdJob.contextMeta);
    expect(meta.skills).toHaveLength(2);
    const dbChip = meta.skills.find((s: any) => s.source === 'db');
    const fileChip = meta.skills.find((s: any) => s.source === 'file');
    expect(dbChip?.name).toBe('DB One');
    expect(fileChip?.id).toBe('persona:engineering-team/senior-fullstack');
    expect(fileChip?.name).toBe('Senior Fullstack');
  });

  it('records the trigger source in contextMeta for the report finalizer', async () => {
    await insertAgent({ schedule: '2h' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'task' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const createArgs = mocks.createJob.mock.calls[0];
    const contextMeta = JSON.parse(createArgs[5]);
    expect(contextMeta.agent.triggeredBy).toBe('schedule');
  });

  it('silently skips persona paths whose file does not exist', async () => {
    await insertAgent({ skillIds: '["persona:nonexistent/missing"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(200);

    const [, , fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).toContain('task');
    expect(fullPrompt).not.toContain('nonexistent');
  });

  describe('dirty worktree gate', () => {
    it('rejects with 409 dirty_worktree when count >= threshold', async () => {
      // Replaces the previous `vi.resetModules()` + full mock reinstall with a
      // simple per-test override on the hoisted mocks.
      mocks.getDirtyFileCount.mockResolvedValue(38);
      settingsMock.dirty_worktree_block_threshold = 20;
      await insertAgent();
      const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'do something' }),
      });
      const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.code).toBe('dirty_worktree');
      expect(data.detail).toContain('38');
      expect(data.detail).toContain('20');
      expect(mocks.startJob).not.toHaveBeenCalled();
    });

    it('does not block when threshold is 0 (disabled)', async () => {
      // settingsMock already has dirty_worktree_block_threshold: 0 from beforeEach
      await insertAgent();
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
        mocks.resolveProjectPath.mockReturnValue(projDir);
        await insertAgent({ docPaths: '["NOTES.md"]' });

        const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
          method: 'POST',
          body: JSON.stringify({ prompt: 'do task' }),
        });
        await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

        const [, , fullPrompt] = mocks.startJob.mock.calls[0];
        expect(fullPrompt).toContain('PROJECT NOTES CONTENT');
        expect(fullPrompt).toContain('## NOTES.md');
        // doc content must appear before the task prompt
        expect(fullPrompt.indexOf('PROJECT NOTES CONTENT')).toBeLessThan(fullPrompt.indexOf('do task'));
      } finally {
        rmSync(projDir, { recursive: true, force: true });
      }
    });

    it('silently skips doc paths whose file does not exist', async () => {
      await insertAgent({ docPaths: '["nonexistent.md"]' });

      const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'do task' }),
      });
      const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
      expect(res.status).toBe(200);

      const [, , fullPrompt] = mocks.startJob.mock.calls[0];
      expect(fullPrompt).toContain('do task');
      expect(fullPrompt).not.toContain('nonexistent');
    });

    it('blocks path traversal outside the project root', async () => {
      const projDir = mkdtempSync(join(tmpdir(), 'tamtam-docpath-'));
      try {
        mocks.resolveProjectPath.mockReturnValue(projDir);
        await insertAgent({ docPaths: '["../../../etc/passwd"]' });

        const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
          method: 'POST',
          body: JSON.stringify({ prompt: 'do task' }),
        });
        const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
        expect(res.status).toBe(200);

        const [, , fullPrompt] = mocks.startJob.mock.calls[0];
        // traversal path is blocked — no /etc/passwd content should appear
        expect(fullPrompt).not.toContain('root:');
        expect(fullPrompt).not.toContain('etc/passwd');
      } finally {
        rmSync(projDir, { recursive: true, force: true });
      }
    });

    it('records resolved docs in contextMeta', async () => {
      // Workflow refactor: docs are resolved inside the compose step and
      // assigned to `job.contextMeta`; assert against the final job state.
      const projDir = mkdtempSync(join(tmpdir(), 'tamtam-docpath-'));
      try {
        writeFileSync(join(projDir, 'GUIDE.md'), 'guide content');
        mocks.resolveProjectPath.mockReturnValue(projDir);
        await insertAgent({ docPaths: '["GUIDE.md"]' });

        const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
          method: 'POST',
          body: JSON.stringify({ prompt: 'task' }),
        });
        await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

        const createdJob = mocks.createJob.mock.results[0].value;
        const contextMeta = JSON.parse(createdJob.contextMeta);
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
  // Re-uses the module-scope mocks; flips `useRealResolveProvider` so the
  // genuine `checkCliStartGate` runs against our mocked `getQuotaSnapshots`.
  let sharedHandle: TestDbHandle;
  let tempSkillsDir: string;
  let snapshots: Map<CliProvider, QuotaSnapshot | null>;

  const now = Date.now() / 1000;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    mocks.useRealResolveProvider = true;
    mocks.db = sharedHandle.db;
    await Promise.all([
      sharedHandle.db.execute(sql.raw('DELETE FROM agents')),
      sharedHandle.db.execute(sql.raw('DELETE FROM skills')),
    ]);
    tempSkillsDir = mkdtempSync(join(tmpdir(), 'tamtam-agent-run-weekly-test-'));
    mocks.skillsDir = tempSkillsDir;
    mocks.dataSkillsDir = join(tempSkillsDir, 'data-skills');

    await sharedHandle.db.insert(schema.agents).values({
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
    });

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

    mocks.startJob.mockReset().mockResolvedValue(12345);
    mocks.createJob.mockReset().mockImplementation(() => makeJob());
    mocks.updateJob.mockReset();
    mocks.listJobs.mockReset().mockReturnValue([]);
    mocks.probeJobStatus.mockReset().mockResolvedValue('done');
    mocks.markDone.mockReset().mockResolvedValue(undefined);
    mocks.getJob.mockReset().mockImplementation(() => makeJob());
    mocks.resolveProjectPath.mockReset().mockReturnValue('/path/to/proj');
    mocks.runGates.mockReset().mockReturnValue(null);
    mocks.enqueueAgentRun.mockReset();
    mocks.enqueueQueuedAgentRun.mockReset();
    mocks.drainNextAgentRun.mockReset().mockResolvedValue(undefined);
    mocks.tryClaimAgentStartSlot.mockReset().mockReturnValue({ ok: true });
    mocks.findBlockingRunningJob.mockReset().mockResolvedValue(null);
    mocks.getLock.mockReset().mockReturnValue(null);
    mocks.isLockOwnedByActiveRelease.mockReset().mockReturnValue(false);
    mocks.getPendingRelease.mockReset().mockReturnValue(false);
    mocks.drainPendingRelease.mockReset().mockResolvedValue(undefined);
    mocks.isProjectPaused.mockReset().mockReturnValue(false);
    mocks.getDirtyFileCount.mockReset().mockResolvedValue(0);
    mocks.shellRun.mockReset().mockImplementation(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mocks.getQuotaSnapshots.mockReset().mockImplementation(() => Promise.resolve(snapshots));
    mocks.getSettings.mockReset().mockImplementation(() => ({
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
    }));
    mocks.getImproveConfig.mockReset().mockImplementation(() => ({ claudeBin: 'claude', logDir: '/tmp/logs' }));
    mocks.getProjectTestConfig.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    rmSync(tempSkillsDir, { recursive: true, force: true });
  });

  it('does not 429 a manual agent run when only weekly quota is hot', async () => {
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(200);
    expect(mocks.startJob).toHaveBeenCalledOnce();
    expect(mocks.createJob.mock.results[0]?.value.provider).toBe('claude');
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
    mocks.getQuotaSnapshots.mockImplementation(() => Promise.resolve(snapshots));
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();
    expect(res.status).toBe(429);
    expect(data.code).toBe('providers_over_budget');
    expect(data.detail).toContain("Selected provider 'claude' is over budget right now");
    expect(mocks.startJob).not.toHaveBeenCalled();
  });
});
