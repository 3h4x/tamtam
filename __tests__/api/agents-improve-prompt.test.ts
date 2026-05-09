import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeMockProcess() {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const stdoutListeners: Record<string, ((chunk: any) => void)[]> = {};
  const stderrListeners: Record<string, ((chunk: any) => void)[]> = {};
  const stdinChunks: string[] = [];
  return {
    pid: 99999,
    stdin: {
      write: vi.fn((data: string) => { stdinChunks.push(data); return true; }),
      end: vi.fn(),
    },
    stdout: {
      on: vi.fn((event: string, cb: (chunk: any) => void) => {
        if (!stdoutListeners[event]) stdoutListeners[event] = [];
        stdoutListeners[event].push(cb);
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (chunk: any) => void) => {
        if (!stderrListeners[event]) stderrListeners[event] = [];
        stderrListeners[event].push(cb);
      }),
    },
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    kill: vi.fn(),
    emitStdout: (data: string) => (stdoutListeners.data ?? []).forEach((cb) => cb(Buffer.from(data, 'utf8'))),
    emitStderr: (data: string) => (stderrListeners.data ?? []).forEach((cb) => cb(Buffer.from(data, 'utf8'))),
    emitClose: (code: number | null) => (listeners.close ?? []).forEach((cb) => cb(code)),
    stdinChunks,
  };
}

describe('POST /api/agents/improve-prompt', () => {
  let POST: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;
  let resolveCliEnvMock: ReturnType<typeof vi.fn>;
  let spawnMock: ReturnType<typeof vi.fn>;
  let projDir: string;
  let mockProc: ReturnType<typeof makeMockProcess>;

  beforeEach(async () => {
    vi.resetModules();
    projDir = mkdtempSync(join(tmpdir(), 'tamtam-improve-prompt-'));
    writeFileSync(join(projDir, 'CLAUDE.md'), '# Test project\n\nSays hello.');

    resolveProjectPathMock = vi.fn().mockReturnValue(projDir);
    checkCliStartGateMock = vi.fn().mockResolvedValue({ ok: true, provider: 'claude' });
    resolveCliEnvMock = vi.fn().mockReturnValue({});
    mockProc = makeMockProcess();
    spawnMock = vi.fn().mockReturnValue(mockProc);

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));
    vi.doMock('@/lib/shared/cli-bin', () => ({
      resolveCliBin: () => 'claude',
      resolveCliEnv: resolveCliEnvMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({}),
      getPermissionModeFlag: () => '--permission-mode bypassPermissions',
    }));
    vi.doMock('@/lib/agents/compose-skills', () => ({
      composeAgentSkills: () => ({ parts: [], docParts: [], metaSkills: [], metaDocs: [] }),
    }));
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<any>('child_process');
      return { ...actual, spawn: spawnMock };
    });

    const mod = await import('@/app/api/agents/improve-prompt/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    rmSync(projDir, { recursive: true, force: true });
    delete process.env.TAMTAM_IMPROVE_PROMPT_TEST;
  });

  it('returns 400 when project is missing', async () => {
    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({ draftPrompt: 'write tests' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when draftPrompt is empty', async () => {
    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({ project: 'alpha', draftPrompt: '' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 when project is unknown', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({ project: 'unknown', draftPrompt: 'do stuff', skillIds: [], docPaths: [] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('returns 429 when budget gate blocks', async () => {
    checkCliStartGateMock.mockResolvedValue({ ok: false, status: 429, detail: 'over budget', provider: null });
    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({ project: 'alpha', draftPrompt: 'do stuff', skillIds: [], docPaths: [] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.code).toBe('providers_over_budget');
  });

  it('spawns claude --print with the draft on stdin and returns improved prompt', async () => {
    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({ project: 'alpha', draftPrompt: 'write tests', skillIds: [], docPaths: [] }),
    });
    const promise = POST(req);
    // Wait a tick so the spawn call happens before we drive its events.
    await new Promise((r) => setTimeout(r, 0));
    expect(spawnMock).toHaveBeenCalled();
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('claude');
    expect(args).toContain('--print');
    expect(args).toContain('--model');
    expect(args).toContain('fast');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).not.toContain('--permission-mode bypassPermissions');

    expect(mockProc.stdinChunks.length).toBe(1);
    expect(mockProc.stdinChunks[0]).toContain('write tests');
    expect(mockProc.stdinChunks[0]).toContain('How TamTam agents work');

    mockProc.emitStdout('Read every test under __tests__/**, identify the slowest 5, and add focused unit tests for any uncovered branches in lib/pipeline.\n');
    mockProc.emitClose(0);

    const res = await promise;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.improvedPrompt).toContain('Read every test');
  });

  it('preserves the process environment while adding provider-specific CLI env', async () => {
    process.env.TAMTAM_IMPROVE_PROMPT_TEST = 'keep-me';
    resolveCliEnvMock.mockReturnValueOnce({ CLAUDE_BIN: '/custom/claude' });

    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({ project: 'alpha', draftPrompt: 'write tests', skillIds: [], docPaths: [] }),
    });
    const promise = POST(req);
    await new Promise((r) => setTimeout(r, 0));

    const options = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env.TAMTAM_IMPROVE_PROMPT_TEST).toBe('keep-me');
    expect(options.env.CLAUDE_BIN).toBe('/custom/claude');
    expect(options.env.HOME).toBeTruthy();
    expect(options.env.PATH).toContain('/usr/local/bin');

    mockProc.emitStdout('Improved prompt\n');
    mockProc.emitClose(0);
    const res = await promise;
    expect(res.status).toBe(200);
  });

  it('returns 502 when claude exits non-zero', async () => {
    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({ project: 'alpha', draftPrompt: 'do stuff', skillIds: [], docPaths: [] }),
    });
    const promise = POST(req);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.emitStderr('boom');
    mockProc.emitClose(1);
    const res = await promise;
    expect(res.status).toBe(502);
  });

  it('strips wrapping markdown fences from the model output', async () => {
    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({ project: 'alpha', draftPrompt: 'do stuff', skillIds: [], docPaths: [] }),
    });
    const promise = POST(req);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.emitStdout('```\nClean output\n```\n');
    mockProc.emitClose(0);
    const res = await promise;
    const data = await res.json();
    expect(data.improvedPrompt).toBe('Clean output');
  });

  it('returns when claude times out and escalates termination if close never fires', async () => {
    vi.useFakeTimers();
    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({ project: 'alpha', draftPrompt: 'do stuff', skillIds: [], docPaths: [] }),
    });
    const promise = POST(req);
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalled();
    });

    await vi.advanceTimersByTimeAsync(120_000);
    const res = await promise;
    expect(res.status).toBe(502);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
