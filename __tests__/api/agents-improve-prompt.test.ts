import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestPgDb, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

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
  let handle: TestDbHandle;

  beforeEach(async () => {
    vi.resetModules();
    handle = await createTestPgDb();
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
    vi.doMock('@/lib/db', () => ({ db: handle.db, schema }));
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<any>('child_process');
      return { ...actual, spawn: spawnMock };
    });

    const mod = await import('@/app/api/agents/improve-prompt/route');
    POST = mod.POST;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.resetModules();
    rmSync(projDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    await handle?.[Symbol.asyncDispose]();
    delete process.env.TAMTAM_IMPROVE_PROMPT_TEST;
    delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  });

  function meta(agentId: string, agentName: string) {
    return JSON.stringify({ agent: { id: agentId, name: agentName, triggeredBy: 'schedule' } });
  }

  function legacyMeta(agentName: string) {
    return JSON.stringify({ agent: { name: agentName, triggeredBy: 'schedule' }, sourceJobId: 'legacy-source' });
  }

  async function insertJob(overrides: Partial<typeof schema.jobs.$inferInsert> = {}) {
    await handle.db.insert(schema.jobs).values({
      id: overrides.id ?? `job-${Math.random()}`,
      project: overrides.project ?? 'alpha',
      kind: overrides.kind ?? 'agent:improve',
      pid: overrides.pid ?? 1,
      startedAt: overrides.startedAt ?? 100,
      finishedAt: overrides.finishedAt ?? 200,
      exitCode: overrides.exitCode ?? 0,
      seen: overrides.seen ?? false,
      contextMeta: overrides.contextMeta ?? meta('agent-1', 'improve'),
      workSummary: overrides.workSummary ?? null,
      modifiedFiles: overrides.modifiedFiles ?? null,
      linesAdded: overrides.linesAdded ?? null,
      linesRemoved: overrides.linesRemoved ?? null,
    });
  }

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
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = '1';
    resolveCliEnvMock.mockReturnValueOnce({
      CLAUDE_BIN: '/custom/claude',
      CODEX_SANDBOX_OVERRIDE: '1',
    });

    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({ project: 'alpha', draftPrompt: 'write tests', skillIds: [], docPaths: [] }),
    });
    const promise = POST(req);
    await new Promise((r) => setTimeout(r, 0));

    const options = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env.TAMTAM_IMPROVE_PROMPT_TEST).toBe('keep-me');
    expect(options.env.CLAUDE_BIN).toBe('/custom/claude');
    expect(options.env.CODEX_SANDBOX_NETWORK_DISABLED).toBeUndefined();
    expect(options.env.CODEX_SANDBOX_OVERRIDE).toBeUndefined();
    expect(options.env.HOME).toBeTruthy();
    expect(options.env.PATH).toContain('/usr/local/bin');

    mockProc.emitStdout('Improved prompt\n');
    mockProc.emitClose(0);
    const res = await promise;
    expect(res.status).toBe(200);
  });

  it('includes low-yield run feedback for existing agents with only low-confidence modified files', async () => {
    await insertJob({
      workSummary: 'Touched only low-confidence noise.',
      modifiedFiles: JSON.stringify([{ path: 'noise.log', status: 'M', confidence: 'low' }]),
      linesAdded: 0,
      linesRemoved: 0,
    });

    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({
        project: 'alpha',
        draftPrompt: 'make useful changes',
        skillIds: [],
        docPaths: [],
        agentId: 'agent-1',
        agentName: 'improve',
      }),
    });
    const promise = POST(req);
    await new Promise((r) => setTimeout(r, 0));

    expect(mockProc.stdinChunks[0]).toContain('## Recent run outcomes (improve around this)');
    expect(mockProc.stdinChunks[0]).toContain('produced changes in only 0 of its last 1 runs');
    expect(mockProc.stdinChunks[0]).toContain('Run 1 (no changes');

    mockProc.emitStdout('Improved prompt\n');
    mockProc.emitClose(0);
    const res = await promise;
    expect(res.status).toBe(200);
  });

  it('includes target-agent feedback even when newer sibling-agent runs dominate project history', async () => {
    await insertJob({
      id: 'target-low-yield',
      startedAt: 100,
      workSummary: 'Target agent found work but landed nothing.',
      linesAdded: 0,
      linesRemoved: 0,
    });
    for (let i = 0; i < 30; i++) {
      await insertJob({
        id: `sibling-${i}`,
        startedAt: 1_000 + i,
        contextMeta: meta('agent-2', 'other'),
        kind: 'agent:other',
        workSummary: `Sibling agent changed file ${i}.`,
        modifiedFiles: JSON.stringify([{ path: `sibling-${i}.ts`, status: 'M' }]),
        linesAdded: 1,
      });
    }

    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({
        project: 'alpha',
        draftPrompt: 'make useful changes',
        skillIds: [],
        docPaths: [],
        agentId: 'agent-1',
        agentName: 'improve',
      }),
    });
    const promise = POST(req);
    await new Promise((r) => setTimeout(r, 0));

    expect(mockProc.stdinChunks[0]).toContain('## Recent run outcomes (improve around this)');
    expect(mockProc.stdinChunks[0]).toContain('Target agent found work but landed nothing.');
    expect(mockProc.stdinChunks[0]).not.toContain('Sibling agent changed file');

    mockProc.emitStdout('Improved prompt\n');
    mockProc.emitClose(0);
    const res = await promise;
    expect(res.status).toBe(200);
  });

  it('includes legacy name-only run feedback without leaking same-name rows from a different agent id', async () => {
    await insertJob({
      id: 'legacy-name-only',
      startedAt: 100,
      contextMeta: legacyMeta('improve'),
      workSummary: 'Legacy improve row found work but landed nothing.',
      linesAdded: 0,
      linesRemoved: 0,
    });
    await insertJob({
      id: 'different-id-same-name',
      startedAt: 200,
      contextMeta: meta('agent-2', 'improve'),
      workSummary: 'Different id same-name row must not appear.',
      modifiedFiles: JSON.stringify([{ path: 'other.ts', status: 'M' }]),
      linesAdded: 1,
    });

    const req = new NextRequest('http://localhost/api/agents/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({
        project: 'alpha',
        draftPrompt: 'make useful changes',
        skillIds: [],
        docPaths: [],
        agentId: 'agent-1',
        agentName: 'improve',
      }),
    });
    const promise = POST(req);
    await new Promise((r) => setTimeout(r, 0));

    expect(mockProc.stdinChunks[0]).toContain('## Recent run outcomes (improve around this)');
    expect(mockProc.stdinChunks[0]).toContain('Legacy improve row found work but landed nothing.');
    expect(mockProc.stdinChunks[0]).not.toContain('Different id same-name row');

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
