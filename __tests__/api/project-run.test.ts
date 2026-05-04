import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeJob() {
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
  };
}

describe('POST /api/projects/by-project/{projectName}/run', () => {
  let POST: any;
  let startJobMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;
  let tempDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-proj-run-test-'));
    skillsDir = join(tempDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    startJobMock = vi.fn().mockResolvedValue(99999);
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/project');
    createJobMock = vi.fn().mockImplementation(() => makeJob());
    updateJobMock = vi.fn();
    checkCliStartGateMock = vi.fn().mockResolvedValue({ ok: true, provider: 'claude' });
    getSettingsMock = vi.fn(() => ({
      cli_enabled_providers: ['claude'],
      cli_bin_claude: '/legacy/claude',
    }));

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi
        .fn()
        .mockReturnValue({ claudeBin: 'claude', logDir: join(tempDir, 'logs') }),
    }));

    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
    }));

    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      startJob: startJobMock,
    }));

    vi.doMock('@/lib/skills/skills', () => ({
      SKILLS_DIR: skillsDir,
      DATA_SKILLS_DIR: join(skillsDir, 'data-skills'),
    }));

    vi.doMock('@/lib/shared/config', () => ({
      withBasePrompt: (p: string) => p,
      getPermissionModeFlag: () => '--permission-mode bypassPermissions',
      getSettings: getSettingsMock,
    }));

    vi.doMock('@/lib/shared/job-control', () => ({
      runGates: () => null,
      jobsPausedResult: () => null,
      runAutoChainGates: () => null,
      isJobsPaused: () => false,
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/run/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 404 if project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
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
    checkCliStartGateMock.mockResolvedValue({
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
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('calls startJob with correct project path', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test prompt' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(startJobMock).toHaveBeenCalledOnce();
    const [, , , projPath] = startJobMock.mock.calls[0];
    expect(projPath).toBe('/path/to/project');
  });

  it('forwards the Claude binary override through CLAUDE_BIN', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test prompt' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, , , , options] = startJobMock.mock.calls[0];
    expect(options).toEqual({ env: { CLAUDE_BIN: '/legacy/claude' } });
  });

  it('defaults terminal runs to the fast tier', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test prompt' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, cmd] = startJobMock.mock.calls[0];
    expect(cmd).toContain('--model fast');
  });

  it('accepts canonical semantic tiers', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test prompt', model: 'smart' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, cmd] = startJobMock.mock.calls[0];
    expect(cmd).toContain('--model smart');
  });

  it('accepts legacy aliases and resolves them to canonical tiers', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test prompt', model: 'sonnet' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, cmd] = startJobMock.mock.calls[0];
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
    expect(startJobMock).not.toHaveBeenCalled();
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
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('calls createJob and updateJob', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(createJobMock).toHaveBeenCalledOnce();
    expect(updateJobMock).toHaveBeenCalledOnce();
  });

  it('prepends persona content when persona file exists', async () => {
    const docsSkillsDir = join(skillsDir, 'docs', 'skills');
    mkdirSync(docsSkillsDir, { recursive: true });
    const personaFile = join(docsSkillsDir, 'my-persona.md');
    writeFileSync(personaFile, '# You are a helpful assistant');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do the thing', persona: 'my-persona' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('# You are a helpful assistant');
    expect(fullPrompt).toContain('do the thing');
  });

  it('ignores persona when file does not exist', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do it', persona: 'nonexistent' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect((res: any) => res).toBeTruthy(); // no error thrown
    const [, , fullPrompt] = startJobMock.mock.calls[0];
    // base_prompt is prepended via withBasePrompt(); persona content is skipped since file doesn't exist
    expect(fullPrompt).toContain('do it');
  });

  it('returns 500 if startJob throws', async () => {
    startJobMock.mockRejectedValue(new Error('pm2 crashed'));
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run this' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('pm2 crashed');
    // Job must be persisted as failed so it doesn't stay "running" in the DB
    expect(updateJobMock).toHaveBeenCalledOnce();
    const savedJob = updateJobMock.mock.calls[0][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });

  it('prepends persona content on follow-up turns (resumeSessionId set)', async () => {
    const docsSkillsDir = join(skillsDir, 'docs', 'skills');
    mkdirSync(docsSkillsDir, { recursive: true });
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

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('# Senior reviewer persona');
    expect(fullPrompt).toContain('follow-up message');
  });

  it('supports multiple personas via personas array on follow-up', async () => {
    const docsSkillsDir = join(skillsDir, 'docs', 'skills');
    mkdirSync(docsSkillsDir, { recursive: true });
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

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('PERSONA-A');
    expect(fullPrompt).toContain('PERSONA-B');
    expect(fullPrompt).toContain('do it');
  });

  it('does NOT inject base_prompt on follow-up turns', async () => {
    vi.resetModules();
    // Re-mock with a recognizable base_prompt via config
    vi.doMock('@/lib/shared/config', () => ({
      withBasePrompt: (p: string) => `BASE-PROMPT-SENTINEL\n\n---\n\n${p}`,
      getPermissionModeFlag: () => '--permission-mode bypassPermissions',
      getSettings: () => ({ cli_enabled_providers: ['claude'] }),
    }));
    // Re-apply other mocks that resetModules cleared
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ claudeBin: 'claude', logDir: join(tempDir, 'logs') }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({ createJob: createJobMock, updateJob: updateJobMock }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/skills/skills', () => ({ SKILLS_DIR: skillsDir, DATA_SKILLS_DIR: join(skillsDir, 'data-skills') }));
    vi.doMock('@/lib/shared/job-control', () => ({
      runGates: () => null,
      jobsPausedResult: () => null,
      runAutoChainGates: () => null,
      isJobsPaused: () => false,
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));
    const mod = await import('@/app/api/projects/by-project/[projectName]/run/route');
    const POST2 = mod.POST;

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'follow up', resumeSessionId: 'sess-1' }),
    });
    await POST2(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).not.toContain('BASE-PROMPT-SENTINEL');
    expect(fullPrompt).toContain('follow up');
  });

  it('DOES inject base_prompt on initial turn (no resumeSessionId)', async () => {
    vi.resetModules();
    vi.doMock('@/lib/shared/config', () => ({
      withBasePrompt: (p: string) => `BASE-PROMPT-SENTINEL\n\n---\n\n${p}`,
      getPermissionModeFlag: () => '--permission-mode bypassPermissions',
      getSettings: () => ({ cli_enabled_providers: ['claude'] }),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ claudeBin: 'claude', logDir: join(tempDir, 'logs') }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({ createJob: createJobMock, updateJob: updateJobMock }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/skills/skills', () => ({ SKILLS_DIR: skillsDir, DATA_SKILLS_DIR: join(skillsDir, 'data-skills') }));
    vi.doMock('@/lib/shared/job-control', () => ({
      runGates: () => null,
      jobsPausedResult: () => null,
      runAutoChainGates: () => null,
      isJobsPaused: () => false,
    }));
    const mod = await import('@/app/api/projects/by-project/[projectName]/run/route');
    const POST2 = mod.POST;

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'first message' }),
    });
    await POST2(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('BASE-PROMPT-SENTINEL');
    expect(fullPrompt).toContain('first message');
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
    expect(createJobMock).toHaveBeenCalledWith(
      'proj1', 'run', 0, '',
      expect.stringContaining('fix the bug'),
      undefined,
      undefined,
      42,
      'owner/repo',
      'Fix login bug',
    );
  });

  it('stores null ghIssue fields when not provided in request body', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(createJobMock).toHaveBeenCalledWith(
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
