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
    mocks.checkDailySpendCap.mockReset().mockResolvedValue({ ok: true });
    mocks.notify.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Only the few persona/file-skill tests populate this; cheaper than a full
    // mkdtemp/rmSync per test.
    rmSync(join(tempSkillsDir, 'docs'), { recursive: true, force: true });
  });

  describe('awaiting_pr_merge gate', () => {
    it('skips scheduled fires when a pr-wait job is in flight for the project', async () => {
      mocks.listJobs.mockReset().mockReturnValue([
        { id: 'proj1-pr-wait-1', project: 'proj1', kind: 'pr-wait', finishedAt: null },
      ]);
      await insertAgent({ schedule: '1h' });
      const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
        method: 'POST',
        headers: { 'x-tamtam-trigger': 'schedule' },
        body: JSON.stringify({ prompt: 'do task' }),
      });
      const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.code).toBe('awaiting_pr_merge');
      expect(data.detail).toMatch(/pr-wait in flight/);
      expect(mocks.startJob).not.toHaveBeenCalled();
    });

    it('allows scheduled fires when the only pr-wait job for the project is finished', async () => {
      mocks.listJobs.mockReset().mockReturnValue([
        { id: 'proj1-pr-wait-1', project: 'proj1', kind: 'pr-wait', finishedAt: Date.now() / 1000 },
      ]);
      await insertAgent({ schedule: '1h' });
      const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
        method: 'POST',
        headers: { 'x-tamtam-trigger': 'schedule' },
        body: JSON.stringify({ prompt: 'do task' }),
      });

      const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

      expect(res.status).toBe(200);
      expect(mocks.startJob).toHaveBeenCalledOnce();
    });

    it('still allows manual (non-schedule) runs even when pr-wait is in flight', async () => {
      mocks.listJobs.mockReset().mockReturnValue([
        { id: 'proj1-pr-wait-1', project: 'proj1', kind: 'pr-wait', finishedAt: null },
      ]);
      await insertAgent();
      const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'do task' /* no triggeredBy => manual */ }),
      });
      const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
      // Manual runs pass this particular gate; downstream gates may still kick in.
      expect(res.status).not.toBe(202);
    });
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

    it('does not block scheduled fires when dirty count is below threshold', async () => {
      mocks.getDirtyFileCount.mockResolvedValue(4);
      settingsMock.dirty_worktree_block_threshold = 10;
      await insertAgent({ schedule: '1h' });
      const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
        method: 'POST',
        headers: { 'x-tamtam-trigger': 'schedule' },
        body: JSON.stringify({ prompt: 'do something' }),
      });

      const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

      expect(res.status).toBe(200);
      expect(mocks.getDirtyFileCount).toHaveBeenCalledWith('/path/to/proj');
    });
  });

  describe('doc_paths', () => {
    it('prepends doc file content before skills in the prompt', async () => {
      const projDir = makeTempCaseDir('docpath');
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
      const projDir = makeTempCaseDir('docpath-traversal');
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
    });

    it('records resolved docs in contextMeta', async () => {
      // Workflow refactor: docs are resolved inside the compose step and
      // assigned to `job.contextMeta`; assert against the final job state.
      const projDir = makeTempCaseDir('docpath-context');
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
    });
  });
});
