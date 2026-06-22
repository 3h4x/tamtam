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

  it('runs prerequisite commands declared in file-backed skill frontmatter', async () => {
    const skillDir = join(tempSkillsDir, 'docs', 'skills', 'tamtam');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'agent-qa.md'), `---
id: agent-qa
name: agent:qa
description: QA agent
prerequisite: |
  echo frontmatter {{project}}
---

Use the QA agent.
`);

    await insertAgent({ skillIds: '["agent-qa"]' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'verify the target' }),
    });

    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(mocks.shellRun).toHaveBeenCalledWith(
      'bash',
      ['-c', 'echo frontmatter proj1'],
      expect.objectContaining({ cwd: '/path/to/proj' }),
    );
    const [, , fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).toContain('## Prerequisite Output');
    expect(fullPrompt).toContain('Command: `echo frontmatter proj1`');
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

  it('dispatches system agents through their internal handler instead of LLM intake', async () => {
    await insertAgent({
      id: 'system:proj1:documentation-reindex-vectors',
      name: 'documentation-reindex-vectors',
      prompt: 'system prompt',
      schedule: '16h',
      kind: 'system',
    });

    const req = new NextRequest('http://localhost/api/agents/system%3Aproj1%3Adocumentation-reindex-vectors/run', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'system:proj1:documentation-reindex-vectors' }) });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'started',
      job_id: 'system-job-1',
      agent: 'documentation-reindex-vectors',
      via: 'system',
    });
    expect(mocks.runSystemAgent).toHaveBeenCalledWith(expect.objectContaining({
      id: 'system:proj1:documentation-reindex-vectors',
      project: 'proj1',
      name: 'documentation-reindex-vectors',
      kind: 'system',
    }));
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('rejects duplicate system-agent manual runs', async () => {
    await insertAgent({
      id: 'system:proj1:documentation-reindex-vectors',
      name: 'documentation-reindex-vectors',
      prompt: 'system prompt',
      schedule: '16h',
      kind: 'system',
    });
    mocks.listJobs.mockReturnValue([
      makeJob({
        id: 'running-system-job',
        project: 'proj1',
        kind: 'agent:documentation-reindex-vectors',
        finishedAt: null,
      }),
    ]);
    mocks.probeJobStatus.mockResolvedValue('running');

    const req = new NextRequest('http://localhost/api/agents/system%3Aproj1%3Adocumentation-reindex-vectors/run', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'system:proj1:documentation-reindex-vectors' }) });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'already_running' });
    expect(mocks.runSystemAgent).not.toHaveBeenCalled();
  });

  it('does not start a dev server when the workflow replay sees an already-finalized job', async () => {
    await insertAgent();
    await insertProject({ devServerStartCommand: 'pnpm dev' });
    const finalizedJob = makeJob({ finishedAt: Date.now() / 1000, exitCode: -1 });
    mocks.createJob.mockReturnValue(finalizedJob);
    mocks.getJob.mockReturnValue(finalizedJob);

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    expect(mocks.ensureDevServerRunning).not.toHaveBeenCalled();
    expect(mocks.startJob).not.toHaveBeenCalled();
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

  it('allows initiative-triggered runs for manual-only agents', async () => {
    await insertAgent({ schedule: null });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'initiative' },
      body: JSON.stringify({ prompt: 'fix the mined chore' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.status).toBe('started');
    expect(mocks.startJob).toHaveBeenCalledOnce();
  });

});
