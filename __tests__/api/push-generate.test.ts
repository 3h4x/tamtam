import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/projects/by-project/[projectName]/push/generate', () => {
  let POST: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;
  let buildDiffContextMock: ReturnType<typeof vi.fn>;

  function makeExecResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
    return { exitCode: 0, stdout: '', stderr: '', ...overrides };
  }

  const FIVE_OPTIONS = [
    '1. feat(auth): add OAuth2 login flow',
    '2. feat: implement OAuth2 login',
    '3. feat(users): support OAuth2 authentication',
    '4. feat: add Google OAuth integration',
    '5. feat(api): add OAuth2 provider support',
  ].join('\n');

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/project');
    getSettingsMock = vi.fn().mockReturnValue({ commit_style: '' });
    buildDiffContextMock = vi.fn().mockReturnValue({ context: 'diff context here' });

    // exec: first two calls are git diff --stat and git diff, last is claudeBin
    execMock = vi.fn()
      .mockResolvedValueOnce(makeExecResult({ stdout: ' 1 file changed' })) // git diff --stat
      .mockResolvedValueOnce(makeExecResult({ stdout: '+added line\n-removed line' })) // git diff
      .mockResolvedValueOnce(makeExecResult({ stdout: FIVE_OPTIONS })); // claudeBin

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/config', () => ({ getSettings: getSettingsMock }));
    vi.doMock('@/lib/diff-context', () => ({ buildDiffContext: buildDiffContextMock }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ claudeBin: 'claude', logDir: '/tmp', projects: {} }),
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/push/generate/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/push/generate', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('project not found');
  });

  it('returns up to 5 commit message options', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/generate', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.options).toHaveLength(5);
    expect(data.error).toBeNull();
    expect(data.model).toBe('haiku');
  });

  it('strips numbering from options', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/generate', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    for (const opt of data.options) {
      expect(opt).not.toMatch(/^\d+[.)]/);
    }
  });

  it('filters non-conventional commits when style guide mentions conventional commits', async () => {
    getSettingsMock.mockReturnValue({ commit_style: 'Use conventional commits format' });
    execMock
      .mockResolvedValueOnce(makeExecResult({ stdout: ' 1 file changed' }))
      .mockResolvedValueOnce(makeExecResult({ stdout: '+line' }))
      .mockResolvedValueOnce(makeExecResult({
        stdout: [
          'feat: good conventional commit',
          'Not a conventional commit',
          'fix(auth): another good one',
          'Random message without type',
          'chore: some maintenance',
        ].join('\n'),
      }));

    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/generate', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    for (const opt of data.options) {
      expect(opt).toMatch(/^(feat|fix|docs|style|refactor|test|chore|ci|build|perf|revert)(\(.+\))?:/i);
    }
  });

  it('returns error:null and empty options on exec failure', async () => {
    execMock.mockReset();
    execMock.mockRejectedValue(new Error('exec failed'));
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/generate', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.options).toEqual([]);
    expect(data.error).toContain('exec failed');
  });

  it('uses haiku model regardless of settings', async () => {
    getSettingsMock.mockReturnValue({ default_model: 'opus', commit_style: '' });
    const req = new NextRequest('http://localhost/api/projects/by-project/myproj/push/generate', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'myproj' }) });
    const data = await res.json();
    expect(data.model).toBe('haiku');
    // Verify the claude call included --model haiku
    const claudeCall = execMock.mock.calls.find((c: any[]) => c[1]?.includes('--model'));
    expect(claudeCall?.[1]).toContain('haiku');
  });
});
