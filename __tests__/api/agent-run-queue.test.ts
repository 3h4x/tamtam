import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import { mocks, applyDdl, resetAgentRunTables, makeJob, loadAgentRunRoute, POST } from './agent-run-fixtures';

describe('POST /api/agents/{agentId}/run', () => {
  let sharedHandle: TestDbHandle;
  let tempSkillsDir: string;
  let tempCaseRoot: string;
  let tempCaseCounter = 0;
  let logDirMock: string;
  let settingsMock: Record<string, unknown>;
  let requestJobCancellationFn: typeof import('@/lib/jobs/cancellation').requestJobCancellation;


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
        createdAt: now,
        updatedAt: now,
        ...overrides,
      });
  }

  async function insertProject(overrides: Record<string, unknown> = {}) {
    await sharedHandle.db
      .insert(schema.projects)
      .values({
        name: 'proj1',
        path: '/path/to/proj',
        devServerStartCommand: null,
        devServerStopCommand: null,
        devServerReadyUrl: null,
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

  function makeTempCaseDir(label: string): string {
    tempCaseCounter += 1;
    const dir = join(tempCaseRoot, `${String(tempCaseCounter).padStart(3, '0')}-${label}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
    mocks.db = sharedHandle.db;
    // One shared skills tempdir per suite (avoids per-test mkdtemp/rmSync churn).
    // Tests that write into it explicitly clean up the inner `docs/` subtree so
    // file-skill content does not leak between cases.
    tempSkillsDir = mkdtempSync(join(tmpdir(), 'tamtam-agent-run-test-'));
    tempCaseRoot = mkdtempSync(join(tmpdir(), 'tamtam-agent-run-cases-'));
    mocks.skillsDir = tempSkillsDir;
    mocks.dataSkillsDir = join(tempSkillsDir, 'data-skills');
    await loadAgentRunRoute();
    ({ requestJobCancellation: requestJobCancellationFn } = await import('@/lib/jobs/cancellation'));
  });

  afterAll(async () => {
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
    rmSync(tempSkillsDir, { recursive: true, force: true });
    rmSync(tempCaseRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    tempCaseCounter = 0;
    mocks.useRealResolveProvider = false;
    mocks.db = sharedHandle.db;
    await resetAgentRunTables(sharedHandle);
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
      if (cmd === 'bash' && args[1] === 'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?pick_top=1"') {
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
    mocks.drainProjectRecoveryWork.mockReset().mockResolvedValue(undefined);
    mocks.isProjectPaused.mockReset().mockReturnValue(false);
    mocks.ensureDevServerRunning.mockReset().mockResolvedValue({ status: 'started', pidfile: {} });
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
    mocks.runSystemAgent.mockReset().mockResolvedValue({ jobId: 'system-job-1' });
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
      body: JSON.stringify({ prompt: 'do something', model: 'smart' }),
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
    expect(entry.modelOverride).toBe('smart');
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
      throw new Error('spawn failed');
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
    await insertAgent({ id: 'agent-456', name: 'Other Agent', schedule: '1h' });
    const pendingStart = deferred<void>();
    mocks.tryClaimAgentStartSlot.mockReturnValueOnce({ ok: true });
    mocks.startJob.mockImplementationOnce(async () => {
      await pendingStart.promise;
      throw new Error('spawn failed');
    });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const pendingFirst = POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    void pendingFirst.catch(() => undefined);
    await Promise.resolve();

    const otherReq = new NextRequest('http://localhost/api/agents/agent-456/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'queued prompt' }),
    });
    const queuedRes = await POST(otherReq, { params: Promise.resolve({ agentId: 'agent-456' }) });
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
      body: JSON.stringify({ prompt: 'do something', model: 'smart' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(202);
    expect(data.status).toBe('queued');
    expect(data.code).toBe('pipeline_lock');
    expect(data.blockingJobId).toBe('release-1');
    expect(mocks.enqueueQueuedAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueQueuedAgentRun.mock.calls[0][1].modelOverride).toBe('smart');
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
    expect(mocks.drainProjectRecoveryWork).toHaveBeenCalledWith('proj1', '[agent-run-route]');
    expect(mocks.drainPendingRelease).not.toHaveBeenCalled();
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
    expect(mocks.drainProjectRecoveryWork).toHaveBeenCalledWith('proj1', '[agent-run-route]');
    expect(mocks.drainPendingRelease).not.toHaveBeenCalled();
    expect(mocks.enqueueQueuedAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('waits on the shared recovery drain before queueing behind a pending release', async () => {
    await insertAgent({ schedule: '1h' });
    const pendingDrain = deferred<void>();
    let releaseActive = false;
    mocks.getPendingRelease.mockReturnValue(true);
    mocks.drainProjectRecoveryWork.mockImplementationOnce(() => pendingDrain.promise);
    mocks.isLockOwnedByActiveRelease.mockImplementation(() => releaseActive);
    mocks.getLock.mockImplementation(() => (
      releaseActive ? { project: 'proj1', lockedByJobId: 'release-1' } : null
    ));
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'do something' }),
    });

    const resPromise = POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    await vi.waitFor(() => {
      expect(mocks.drainProjectRecoveryWork).toHaveBeenCalledWith('proj1', '[agent-run-route]');
    });

    expect(mocks.enqueueQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.startJob).not.toHaveBeenCalled();

    releaseActive = true;
    pendingDrain.resolve();
    const res = await resPromise;
    const data = await res.json();

    expect(res.status).toBe(202);
    expect(data.status).toBe('queued');
    expect(data.code).toBe('pipeline_lock');
    expect(data.blockingJobId).toBe('release-1');
    expect(mocks.enqueueQueuedAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.drainPendingRelease).not.toHaveBeenCalled();
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

});
