import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CliProvider } from '@/lib/usage/cli-providers';
import type { QuotaSnapshot } from '@/lib/usage/quota-types';

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-job-id',
    project: 'proj1',
    kind: 'run',
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

// Hoisted shared state used by module-scope vi.mock() factories below.
// We keep a single set of module mocks installed at module load time and
// mutate `state.*` between tests instead of repeatedly calling
// `vi.resetModules()` + `vi.doMock()` + `await import(...)` per test
// (which would rebuild the route's entire module graph each time).
const state = vi.hoisted(() => {
  const fns = {
    startJob: vi.fn().mockResolvedValue(99999),
    resolveProjectPath: vi.fn().mockReturnValue('/path/to/project'),
    createJob: vi.fn(),
    updateJob: vi.fn(),
    checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }),
    findBlockingRunningJob: vi.fn().mockResolvedValue(null),
    getSettings: vi.fn(),
    getImproveConfig: vi.fn(),
    getQuotaSnapshots: vi.fn().mockResolvedValue(new Map()),
  };
  return {
    fns,
    // Adjustable behavior per-test without resetting modules.
    skillsDir: '',
    cwdOverride: '',
    withBasePrompt: (p: string) => p as string,
    resolveAutoAttachedDocs: (_projectPath: string, _prompt: string, _config: unknown) =>
      [] as Array<{ rulePath: string; absolutePath: string; name: string; content: string; matchedKeyword: string }>,
  };
});

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: (...args: unknown[]) => state.fns.resolveProjectPath(...args),
}));
vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: (...args: unknown[]) => state.fns.getImproveConfig(...args),
}));
vi.mock('@/lib/jobs/job-storage', () => ({
  createJob: (...args: unknown[]) => state.fns.createJob(...args),
  updateJob: (...args: unknown[]) => state.fns.updateJob(...args),
}));
vi.mock('@/lib/jobs/project-active-job', () => ({
  findBlockingRunningJob: (...args: unknown[]) => state.fns.findBlockingRunningJob(...args),
}));
vi.mock('@/lib/jobs/pm2-jobs', () => ({
  startJob: (...args: unknown[]) => state.fns.startJob(...args),
  splitCommand: (line: string) => line.split(/\s+/).filter(Boolean),
}));
vi.mock('@/lib/jobs/spawn-claude-detached', () => ({
  startJobInProcess: (...args: unknown[]) => state.fns.startJob(...args),
}));
vi.mock('@/lib/skills/skills', () => ({
  get SKILLS_DIR() { return state.skillsDir; },
  get DATA_SKILLS_DIR() { return join(state.skillsDir, 'data-skills'); },
}));
vi.mock('@/lib/shared/config', () => ({
  withBasePrompt: (p: string, ...rest: unknown[]) => state.withBasePrompt(p, ...(rest as [])),
  getPermissionModeFlag: () => '--permission-mode bypassPermissions',
  getSettings: (...args: unknown[]) => state.fns.getSettings(...args),
}));
vi.mock('@/lib/shared/job-control', () => ({
  runGates: () => null,
  jobsPausedResult: () => null,
  runAutoChainGates: () => null,
  isJobsPaused: () => false,
}));
vi.mock('@/lib/usage/resolve-provider', () => ({
  checkCliStartGate: (...args: unknown[]) => state.fns.checkCliStartGate(...args),
}));
vi.mock('@/lib/usage/quota', () => ({
  getQuotaSnapshots: (...args: unknown[]) => state.fns.getQuotaSnapshots(...args),
}));
vi.mock('@/lib/skills/tamtam-file-config', () => ({
  loadFileConfig: () => null,
}));
vi.mock('@/lib/skills/auto-attach-docs', async () => {
  const actual = await vi.importActual<typeof import('@/lib/skills/auto-attach-docs')>(
    '@/lib/skills/auto-attach-docs',
  );
  return {
    ...actual,
    resolveAutoAttachedDocs: (...args: unknown[]) => state.resolveAutoAttachedDocs(...(args as [string, string, never])),
  };
});

// Import the route once — module-scope mocks above are hoisted before this.
const routeModulePromise = import('@/app/api/projects/by-project/[projectName]/run/route');

describe('POST /api/projects/by-project/{projectName}/run', () => {
  let POST: Awaited<typeof routeModulePromise>['POST'];
  let tempDir: string;
  let skillsDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-proj-run-test-'));
    skillsDir = join(tempDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    // Reset hoisted shared state to default per-test behavior.
    state.skillsDir = skillsDir;
    state.cwdOverride = '';
    state.withBasePrompt = (p: string) => p;
    state.resolveAutoAttachedDocs = () => [];

    state.fns.startJob.mockReset().mockResolvedValue(99999);
    state.fns.resolveProjectPath.mockReset().mockReturnValue('/path/to/project');
    state.fns.createJob.mockReset().mockImplementation(() => makeJob());
    state.fns.updateJob.mockReset();
    state.fns.checkCliStartGate.mockReset().mockResolvedValue({ ok: true, provider: 'claude' });
    state.fns.findBlockingRunningJob.mockReset().mockResolvedValue(null);
    state.fns.getSettings.mockReset().mockImplementation(() => ({
      cli_enabled_providers: ['claude'],
      cli_bin_claude: '/legacy/claude',
    }));
    state.fns.getImproveConfig.mockReset().mockReturnValue({
      claudeBin: 'claude',
      logDir: join(tempDir, 'logs'),
    });

    POST = (await routeModulePromise).POST;
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = null;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 404 if project not found', async () => {
    state.fns.resolveProjectPath.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('project not found');
  });

  it('returns 400 if prompt is empty', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: '' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('Prompt');
  });

  it('returns 400 if prompt is whitespace only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: '   ' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
  });

  it('starts job and returns job info for JSON body', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run my agent' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBeTruthy();
    expect(data.log_path).toBeTruthy();
  });

  it('returns 429 when every enabled provider is over budget', async () => {
    state.fns.checkCliStartGate.mockResolvedValue({
      ok: false,
      status: 429,
      detail: 'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.',
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run my agent' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(429);
    expect(state.fns.startJob).not.toHaveBeenCalled();
  });

  it('treats an explicit terminal provider as required instead of falling back', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run my agent', provider: 'claude' }),
    });

    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(state.fns.checkCliStartGate).toHaveBeenCalledWith('start a terminal run', {
      preferred: 'claude',
      strictPreferred: true,
      requestedModel: 'fast',
      respectJobsPaused: false,
    });
  });

  it('rejects a resumed terminal run when the original provider cannot be reused', async () => {
    state.fns.checkCliStartGate.mockResolvedValue({ ok: true, provider: 'codex' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'follow up',
        provider: 'claude',
        resumeSessionId: 'sess-123',
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('original session ran on claude');
    expect(state.fns.startJob).not.toHaveBeenCalled();
  });

  it('returns 409 with blocking_job_id when another project job is already running', async () => {
    state.fns.findBlockingRunningJob.mockResolvedValue(makeJob({ id: 'run-123', kind: 'review' }));
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run my agent' }),
    });

    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain("Job 'review' is already running");
    expect(data.blocking_job_id).toBe('run-123');
    expect(state.fns.checkCliStartGate).not.toHaveBeenCalled();
    expect(state.fns.startJob).not.toHaveBeenCalled();
  });

  it('calls startJob with correct project path', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test prompt' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(state.fns.startJob).toHaveBeenCalledOnce();
    const [, , , projPath] = state.fns.startJob.mock.calls[0];
    expect(projPath).toBe('/path/to/project');
  });

  it('forwards the Claude binary override through CLAUDE_BIN', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test prompt' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, , , , options] = state.fns.startJob.mock.calls[0];
    expect(options).toEqual({ env: { CLAUDE_BIN: '/legacy/claude' } });
  });

  it('defaults terminal runs to the fast tier', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test prompt' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, cmd] = state.fns.startJob.mock.calls[0];
    expect(cmd).toContain('--model fast');
  });

  it('accepts canonical semantic tiers', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test prompt', model: 'smart' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, cmd] = state.fns.startJob.mock.calls[0];
    expect(cmd).toContain('--model smart');
  });

  it('accepts legacy aliases and resolves them to canonical tiers', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test prompt', model: 'sonnet' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, cmd] = state.fns.startJob.mock.calls[0];
    expect(cmd).toContain('--model normal');
    expect(cmd).not.toContain('--model sonnet');
  });

  it('rejects invalid JSON models and does not start a job', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test prompt', model: 'smart --resume injected' }),
    });

    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      detail: expect.stringContaining('Invalid model'),
    });
    expect(state.fns.startJob).not.toHaveBeenCalled();
  });

  it('rejects invalid multipart models and does not start a job', async () => {
    const form = new FormData();
    form.set('prompt', 'test prompt');
    form.set('model', 'smart --resume injected');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: form,
    });

    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      detail: expect.stringContaining('Invalid model'),
    });
    expect(state.fns.startJob).not.toHaveBeenCalled();
  });

  it('accepts attachment-only multipart runs and injects the saved file path into the prompt', async () => {
    const form = new FormData();
    form.set('file', new File(['hello world'], 'notes.txt', { type: 'text/plain' }));
    const originalCwd = process.cwd();

    // Thread-pool tests can't call process.chdir(); spy on process.cwd()
    // instead — the route reads `process.cwd()` once when computing the
    // attachments dir, so redirecting it is equivalent to chdir for this
    // test's purposes (and the attachments dir is created via mkdirSync,
    // which works against any path).
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: form,
    });

    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(res.status).toBe(200);
    const [, , fullPrompt] = state.fns.startJob.mock.calls[0];
    expect(fullPrompt).toContain('See the attached files.');
    expect(fullPrompt).toContain('Attached files (read them to see their content):');
    expect(fullPrompt).toContain(join(tempDir, 'data', 'attachments'));
    expect(fullPrompt).not.toContain(join(originalCwd, 'data', 'attachments'));
    expect(fullPrompt).toMatch(/data\/attachments\/[a-f0-9]{8}\.txt/);
  });

  it('calls createJob and updateJob', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(state.fns.createJob).toHaveBeenCalledOnce();
    expect(state.fns.updateJob).toHaveBeenCalledOnce();
  });

  it('bypasses the global pause for manual terminal runs explicitly', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello' }),
    });

    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(state.fns.checkCliStartGate).toHaveBeenCalledWith('start a terminal run', {
      preferred: undefined,
      strictPreferred: false,
      requestedModel: 'fast',
      respectJobsPaused: false,
    });
  });

  it('prepends persona content when persona file exists', async () => {
    const docsSkillsDir = join(skillsDir, 'docs', 'skills');
    mkdirSync(docsSkillsDir, { recursive: true });
    const { writeFileSync } = await import('fs');
    writeFileSync(join(docsSkillsDir, 'my-persona.md'), '# You are a helpful assistant');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do the thing', persona: 'my-persona' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, , fullPrompt] = state.fns.startJob.mock.calls[0];
    expect(fullPrompt).toContain('# You are a helpful assistant');
    expect(fullPrompt).toContain('do the thing');
  });

  it('ignores persona when file does not exist', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do it', persona: 'nonexistent' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect((res: unknown) => res).toBeTruthy(); // no error thrown
    const [, , fullPrompt] = state.fns.startJob.mock.calls[0];
    // base_prompt is prepended via withBasePrompt(); persona content is skipped since file doesn't exist
    expect(fullPrompt).toContain('do it');
  });

  it('returns 500 if startJob throws', async () => {
    state.fns.startJob.mockRejectedValue(new Error('pm2 crashed'));
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run this' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('pm2 crashed');
    // Job must be persisted as failed so it doesn't stay "running" in the DB
    expect(state.fns.updateJob).toHaveBeenCalledOnce();
    const savedJob = state.fns.updateJob.mock.calls[0][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });

  it('prepends persona content on follow-up turns (resumeSessionId set)', async () => {
    const docsSkillsDir = join(skillsDir, 'docs', 'skills');
    mkdirSync(docsSkillsDir, { recursive: true });
    const { writeFileSync } = await import('fs');
    writeFileSync(join(docsSkillsDir, 'reviewer.md'), '# Senior reviewer persona');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'follow-up message',
        persona: 'reviewer',
        resumeSessionId: 'sess-abc-123',
      }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, , fullPrompt] = state.fns.startJob.mock.calls[0];
    expect(fullPrompt).toContain('# Senior reviewer persona');
    expect(fullPrompt).toContain('follow-up message');
  });

  it('supports multiple personas via personas array on follow-up', async () => {
    const docsSkillsDir = join(skillsDir, 'docs', 'skills');
    mkdirSync(docsSkillsDir, { recursive: true });
    const { writeFileSync } = await import('fs');
    writeFileSync(join(docsSkillsDir, 'a.md'), 'PERSONA-A');
    writeFileSync(join(docsSkillsDir, 'b.md'), 'PERSONA-B');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'do it',
        personas: ['a', 'b'],
        resumeSessionId: 'sess-xyz',
      }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, , fullPrompt] = state.fns.startJob.mock.calls[0];
    expect(fullPrompt).toContain('PERSONA-A');
    expect(fullPrompt).toContain('PERSONA-B');
    expect(fullPrompt).toContain('do it');
  });

  it('does NOT inject base_prompt on follow-up turns', async () => {
    state.withBasePrompt = (p: string) => `BASE-PROMPT-SENTINEL\n\n---\n\n${p}`;

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'follow up', resumeSessionId: 'sess-1' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, , fullPrompt] = state.fns.startJob.mock.calls[0];
    expect(fullPrompt).not.toContain('BASE-PROMPT-SENTINEL');
    expect(fullPrompt).toContain('follow up');
  });

  it('DOES inject base_prompt on initial turn (no resumeSessionId)', async () => {
    state.withBasePrompt = (p: string) => `BASE-PROMPT-SENTINEL\n\n---\n\n${p}`;

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'first message' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, , fullPrompt] = state.fns.startJob.mock.calls[0];
    expect(fullPrompt).toContain('BASE-PROMPT-SENTINEL');
    expect(fullPrompt).toContain('first message');
  });

  it('auto-attaches docs on initial turn when keyword matches', async () => {
    state.resolveAutoAttachedDocs = () => [
      {
        rulePath: 'docs/TEST.md',
        absolutePath: '/abs/docs/TEST.md',
        name: 'TEST.md',
        content: 'TEST-DOC-CONTENT',
        matchedKeyword: 'test',
      },
    ];
    const created = makeJob();
    state.fns.createJob.mockImplementation(() => created);

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'fix the test' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, , fullPrompt] = state.fns.startJob.mock.calls[0];
    expect(fullPrompt).toContain('TEST-DOC-CONTENT');
    expect(fullPrompt).toContain('Auto-attached docs');

    const contextMeta = state.fns.createJob.mock.calls[0][5];
    expect(contextMeta).toBeTruthy();
    expect(JSON.parse(contextMeta as string).autoAttachedDocs).toEqual(['docs/TEST.md']);
  });

  it('does NOT auto-attach docs on follow-up turns (resumeSessionId set)', async () => {
    state.resolveAutoAttachedDocs = () => [
      {
        rulePath: 'docs/TEST.md',
        absolutePath: '/abs/docs/TEST.md',
        name: 'TEST.md',
        content: 'TEST-DOC-CONTENT',
        matchedKeyword: 'test',
      },
    ];

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'fix the test again', resumeSessionId: 'sess-1' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, , fullPrompt] = state.fns.startJob.mock.calls[0];
    expect(fullPrompt).not.toContain('TEST-DOC-CONTENT');
    expect(fullPrompt).not.toContain('Auto-attached docs');
  });

  it('passes ghIssue fields to createJob from JSON body', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'fix the bug',
        ghIssueNumber: 42,
        ghIssueRepo: 'owner/repo',
        ghIssueTitle: 'Fix login bug',
      }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(state.fns.createJob).toHaveBeenCalledWith(
      'proj1', 'run', 0, '',
      expect.stringContaining('fix the bug'),
      undefined,
      undefined,
      42,
      'owner/repo',
      'Fix login bug',
    );
  });

  it('returns 400 when ghIssueNumber is provided without ghIssueRepo', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'fix the bug',
        ghIssueNumber: 42,
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('ghIssueRepo');
    expect(state.fns.createJob).not.toHaveBeenCalled();
    expect(state.fns.startJob).not.toHaveBeenCalled();
  });

  it('stores null ghIssue fields when not provided in request body', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(state.fns.createJob).toHaveBeenCalledWith(
      'proj1', 'run', 0, '',
      expect.stringContaining('do something'),
      undefined,
      undefined,
      null,
      null,
      null,
    );
  });
});

describe('POST /api/projects/by-project/{projectName}/run weekly quota gating', () => {
  let POST: Awaited<typeof routeModulePromise>['POST'];
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-proj-run-weekly-test-'));

    state.skillsDir = join(tempDir, 'skills');
    state.withBasePrompt = (p: string) => p;

    state.fns.startJob.mockReset().mockResolvedValue(99999);
    state.fns.resolveProjectPath.mockReset().mockReturnValue('/path/to/project');
    state.fns.createJob.mockReset().mockImplementation(() => makeJob());
    state.fns.updateJob.mockReset();
    state.fns.findBlockingRunningJob.mockReset().mockResolvedValue(null);
    // Use real checkCliStartGate by clearing the mock so the route's
    // resolve-provider path actually consults the quota snapshots. Vitest's
    // module-scope mock still proxies through `state.fns.checkCliStartGate`,
    // so swap the implementation in to call the real exported function.
    const real = await vi.importActual<typeof import('@/lib/usage/resolve-provider')>(
      '@/lib/usage/resolve-provider'
    );
    state.fns.checkCliStartGate.mockReset().mockImplementation(real.checkCliStartGate);

    state.fns.getImproveConfig.mockReset().mockReturnValue({
      claudeBin: 'claude',
      logDir: join(tempDir, 'logs'),
    });
    state.fns.getSettings.mockReset().mockImplementation(() => ({
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
      cli_bin_claude: '/legacy/claude',
      cli_bin_codex: '',
      cli_bin_gemini: '',
      cli_bin_lmstudio: '',
    }));

    POST = (await routeModulePromise).POST;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not 429 a manual terminal run when only weekly quota is hot', async () => {
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
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
    state.fns.getQuotaSnapshots.mockResolvedValue(snapshots);

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run my agent' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(state.fns.startJob).toHaveBeenCalledOnce();
    const [, cmd, , , options] = state.fns.startJob.mock.calls[0];
    expect(cmd).toContain('/scripts/claude-shim.js');
    expect(options).toEqual({ env: { CLAUDE_BIN: '/legacy/claude' } });
  });

  it('keeps Claude selected for a fast terminal run when only the sonnet weekly window is hot', async () => {
    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', {
        provider: 'claude',
        fiveHour: { utilization: 24, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 20, resetsAt: null, msUntilReset: null },
        sevenDaySonnet: { utilization: 100, resetsAt: null, msUntilReset: null },
        sevenDayOpus: null,
        fetchedAt: 0,
        stale: false,
      }],
      ['codex', {
        provider: 'codex',
        fiveHour: { utilization: 30, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 50, resetsAt: null, msUntilReset: null },
        fetchedAt: 0,
        stale: false,
      }],
    ]);
    state.fns.getQuotaSnapshots.mockResolvedValue(snapshots);

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run my agent', model: 'fast' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(res.status).toBe(200);
    expect(state.fns.startJob).toHaveBeenCalledOnce();
    const [, cmd, , , options] = state.fns.startJob.mock.calls[0];
    expect(cmd).toContain('/scripts/claude-shim.js');
    expect(options).toEqual({ env: { CLAUDE_BIN: '/legacy/claude' } });
  });
});
