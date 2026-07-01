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
      isScheduled: false,
    });
  });

  it('uses a valid body model override for the run gate and workflow command', async () => {
    await insertAgent({ model: 'fast' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run tests', model: 'opus' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    expect(mocks.checkCliStartGate).toHaveBeenCalledWith('start an agent run', {
      preferred: null,
      strictPreferred: false,
      requestedModel: 'smart',
      respectJobsPaused: false,
      isScheduled: false,
    });
    const [, cmd] = mocks.startJob.mock.calls[0];
    expect(cmd).toContain('--model smart');
  });

  it('rejects invalid body model overrides instead of coercing to normal', async () => {
    await insertAgent({ model: 'fast' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run tests', model: 'smart --resume injected' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.detail).toContain('Invalid model');
    expect(mocks.checkCliStartGate).not.toHaveBeenCalled();
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('uses the stored agent model when body model is omitted', async () => {
    await insertAgent({ model: 'smart' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run tests' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    expect(res.status).toBe(200);
    expect(mocks.checkCliStartGate).toHaveBeenCalledWith('start an agent run', {
      preferred: null,
      strictPreferred: false,
      requestedModel: 'smart',
      respectJobsPaused: false,
      isScheduled: false,
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
    mocks.startJob.mockRejectedValue(new Error('spawn not available'));
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('spawn not available');
    // Job must be persisted as failed so it doesn't stay "running" in the DB
    expect(mocks.updateJob).toHaveBeenCalled();
    const savedJob = mocks.updateJob.mock.calls[mocks.updateJob.mock.calls.length - 1][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });

  it('prepends file-based persona content when skillIds contains persona:<path>', async () => {
    const docsDir = join(tempSkillsDir, 'docs', 'skills', 'engineering');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'fullstack.md'), 'FULLSTACK-PERSONA-BODY');

    await insertAgent({ skillIds: '["persona:engineering/fullstack"]' });

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
    const tempRoot = makeTempCaseDir('prereq-redaction');
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
      ['-c', 'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?pick_top=1"'],
      expect.objectContaining({ cwd: '/path/to/proj' }),
    );
    const [, cmd, fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).toContain('## Prerequisite Output');
    expect(fullPrompt).toContain('pick_top=1');
    expect(fullPrompt).toContain('Trusted issue');
    // Defense-in-depth: every gh issue surface (reads + writes via CLI + REST API)
    // plus the git branch-switch primitives must be blocked at the Claude
    // permission layer for issue-cruncher agents.
    expect(cmd).toContain('--disallowed-tools');
    expect(cmd).toContain('Bash(gh issue:*)');
    expect(cmd).toContain('Bash(gh api repos/*/issues:*)');
    expect(cmd).toContain('Bash(gh api repos/*/issues/*:*)');
    expect(cmd).toContain('Bash(git checkout:*)');
    expect(cmd).toContain('Bash(git switch:*)');
  });

  it('does not pass --disallowed-tools when the agent has no issue-cruncher skill', async () => {
    await insertAgent({ skillIds: '[]' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'something else' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    const [, cmd] = mocks.startJob.mock.calls[0];
    expect(cmd).not.toContain('--disallowed-tools');
    expect(cmd).not.toContain('gh issue');
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
      ['-c', 'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?pick_top=1"'],
      expect.anything(),
    );
    const [, , fullPrompt] = mocks.startJob.mock.calls[0];
    expect(fullPrompt).not.toContain('## Prerequisite Output');
    expect(fullPrompt).not.toContain('pick_top=1');
  });

  it('creates the log directory before writing the prerequisite artifact', async () => {
    const tempRoot = makeTempCaseDir('prereq-logdir');
    logDirMock = join(tempRoot, 'missing-logs');
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

    const cancellation = requestJobCancellationFn(sharedJob.id, 1_000);
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

  it('records resolved skills in contextMeta so the terminal toolbar can show chips', async () => {
    // Workflow refactor: skills/docs/baseline are now resolved inside the
    // compose step and written to `job.contextMeta` (which the workflow's
    // start step then persists via `updateJob`). The initial createJob value
    // only carries the agent meta. Assert against the final job state.
    const docsDir = join(tempSkillsDir, 'docs', 'skills', 'engineering');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'fullstack.md'), '---\nname: Fullstack\n---\nbody');

    await sharedHandle.db
      .insert(schema.skills)
      .values({ id: 'skill-db', name: 'DB One', description: 'desc', content: 'x', createdAt: now, updatedAt: now });
    await insertAgent({ skillIds: '["skill-db","persona:engineering/fullstack"]' });

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
    expect(fileChip?.id).toBe('persona:engineering/fullstack');
    expect(fileChip?.name).toBe('Fullstack');

    const runSkills = JSON.parse(createdJob.skillIds);
    expect(runSkills).toHaveLength(2);
    expect(runSkills[0]).toMatchObject({ id: 'skill-db', name: 'DB One', source: 'db' });
    expect(runSkills[0].promptChars).toBeGreaterThan(0);
    expect(runSkills[1]).toMatchObject({ id: 'persona:engineering/fullstack', name: 'Fullstack', source: 'file' });
    expect(runSkills[1].promptChars).toBeGreaterThan(0);
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

});
