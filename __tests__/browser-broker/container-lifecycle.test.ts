import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

describe('ensureBrokerRunning', () => {
  let runShellMock: ReturnType<typeof vi.fn>;
  let allocatePortMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    allocatePortMock = vi.fn().mockResolvedValue(4321);
    runShellMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'info') return { exitCode: 0, stdout: '27', stderr: '' };
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'rm' && args[1] === '-f') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'run') return { exitCode: 0, stdout: 'container-id\n', stderr: '' };
      if (args[0] === 'inspect' && args[1] === '--format') return { exitCode: 0, stdout: 'true 0 \n', stderr: '' };
      throw new Error(`unexpected docker command: ${args.join(' ')}`);
    });

    vi.doMock('@/lib/shared/shell', () => ({
      exec: runShellMock,
    }));
    // getSettings() fires a fire-and-forget DB-backed background refresh whose
    // failure path logs via console.error. With no DB reachable in the worker it
    // rejects asynchronously after these fast tests finish, racing vitest's RPC
    // teardown ("Closing rpc while onUserConsoleLog was pending"). Mock it so no
    // floating promise is created.
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ browser_broker_mode: 'docker' }),
    }));
    vi.doMock('@/lib/browser-broker/port-allocator', () => ({
      allocatePort: allocatePortMock,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
  });

  afterEach(async () => {
    try {
      const { stopBroker } = await import('@/lib/browser-broker/container-lifecycle');
      await stopBroker();
    } catch {
      // Individual tests reset and mock modules aggressively; if import failed,
      // the globals below still prevent broker state from leaking to the worker.
    }
    delete (globalThis as typeof globalThis & {
      __tamtamBrowserBroker?: unknown;
      __tamtamBrowserBrokerStarting?: unknown;
    }).__tamtamBrowserBroker;
    delete (globalThis as typeof globalThis & {
      __tamtamBrowserBroker?: unknown;
      __tamtamBrowserBrokerStarting?: unknown;
      __tamtamBrowserBrokerShutdownHookInstalled?: unknown;
    }).__tamtamBrowserBrokerStarting;
    delete (globalThis as typeof globalThis & {
      __tamtamBrowserBroker?: unknown;
      __tamtamBrowserBrokerStarting?: unknown;
      __tamtamBrowserBrokerShutdownHookInstalled?: unknown;
    }).__tamtamBrowserBrokerShutdownHookInstalled;
    delete (globalThis as typeof globalThis & {
      __tamtamBrowserBrokerShutdownHooks?: unknown;
    }).__tamtamBrowserBrokerShutdownHooks;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts a configured non-MCP broker image through the legacy npx entrypoint', async () => {
    const { ensureBrokerRunning } = await import('@/lib/browser-broker/container-lifecycle');

    const handle = await ensureBrokerRunning({ image: 'custom/broker:1' });

    expect(handle.url).toBe('http://127.0.0.1:4321');
    expect(runShellMock.mock.calls.some(([, args]) => args[0] === 'image' && args[1] === 'inspect' && args[2] === 'custom/broker:1')).toBe(true);
    expect(runShellMock.mock.calls.some(([, args]) => args[0] === 'pull' && args[1] === 'custom/broker:1')).toBe(false);
    expect(runShellMock.mock.calls.some(([, args]) => args[0] === 'run' && args.includes('custom/broker:1'))).toBe(true);
    const runCall = runShellMock.mock.calls.find(([, args]) => args[0] === 'run');
    const runArgs = runCall?.[1] ?? [];
    const imageIndex = runArgs.indexOf('custom/broker:1');

    expect(imageIndex).toBeGreaterThan(-1);
    expect(runArgs.slice(imageIndex, imageIndex + 3)).toEqual([
      'custom/broker:1',
      'sh',
      '-c',
    ]);
    expect(runArgs[imageIndex + 3]).toContain('npx -y @playwright/mcp@0.0.30');
    expect(runArgs[imageIndex + 3]).toContain('--port 9333');
    expect(runArgs[imageIndex + 3]).toContain('--host 0.0.0.0');
    expect(runArgs[imageIndex + 3]).not.toContain('--allowed-hosts');
    expect(runArgs[imageIndex + 3]).toContain('--browser chromium');
    expect(runArgs[imageIndex + 3]).toContain('--headless');
    expect(runArgs[imageIndex + 3]).toContain('--no-sandbox');
    expect(runArgs[imageIndex + 3]).toContain('--isolated');
    expect(runArgs).not.toContain('--entrypoint');
    expect(runArgs).not.toContain('/app/cli.js');
  });

  it('starts the pinned broker MCP image through its HTTP service entrypoint', async () => {
    const { ensureBrokerRunning } = await import('@/lib/browser-broker/container-lifecycle');

    await ensureBrokerRunning();

    expect(runShellMock.mock.calls.some(([, args]) => args[0] === 'image' && args[1] === 'inspect' && args[2] === 'mcr.microsoft.com/playwright/mcp:v0.0.30')).toBe(true);
    const runCall = runShellMock.mock.calls.find(([, args]) => args[0] === 'run');
    const runArgs = runCall?.[1] ?? [];
    const imageIndex = runArgs.indexOf('mcr.microsoft.com/playwright/mcp:v0.0.30');

    expect(runArgs).toEqual(expect.arrayContaining([
      '-i',
      '--init',
      '--entrypoint', 'node',
      'mcr.microsoft.com/playwright/mcp:v0.0.30',
      '/app/cli.js',
    ]));
    expect(imageIndex).toBeGreaterThan(-1);
    expect(runArgs.slice(imageIndex - 2, imageIndex + 2)).toEqual([
      '--entrypoint',
      'node',
      'mcr.microsoft.com/playwright/mcp:v0.0.30',
      '/app/cli.js',
    ]);
    expect(runCall?.[1]).toEqual(expect.arrayContaining([
      '--port', '9333',
      '--host', '0.0.0.0',
      '--browser', 'chromium',
      '--headless',
      '--no-sandbox',
      '--isolated',
    ]));
    expect(runCall?.[1]).not.toContain('--allowed-hosts');
    expect(runCall?.[1]).not.toContain('--rm');
    expect(runCall?.[1]).not.toContain('sh');
    expect(runCall?.[1]).not.toContain('npx');
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:4321/mcp', expect.objectContaining({ method: 'GET' }));
  });

  it('falls back to the legacy SSE endpoint when streamable HTTP is unavailable', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ status: 404 } as Response)
      .mockResolvedValueOnce({ status: 200 } as Response);
    const { ensureBrokerRunning } = await import('@/lib/browser-broker/container-lifecycle');

    const handle = await ensureBrokerRunning();

    expect(handle.mcpUrl).toBe('http://127.0.0.1:4321/sse');
    expect(fetch).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:4321/mcp', expect.objectContaining({ method: 'GET' }));
    expect(fetch).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:4321/sse', expect.objectContaining({ method: 'GET' }));
  });

  it('fails fast with container logs when the broker container exits before health', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('not listening'));
    runShellMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'info') return { exitCode: 0, stdout: '27', stderr: '' };
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'rm' && args[1] === '-f') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'run') return { exitCode: 0, stdout: 'container-id\n', stderr: '' };
      if (args[0] === 'inspect' && args[1] === '--format') return { exitCode: 0, stdout: 'false 1 \n', stderr: '' };
      if (args[0] === 'logs') return { exitCode: 0, stdout: 'startup failed\n', stderr: '' };
      throw new Error(`unexpected docker command: ${args.join(' ')}`);
    });

    const { ensureBrokerRunning } = await import('@/lib/browser-broker/container-lifecycle');

    await expect(ensureBrokerRunning({ healthTimeoutMs: 10 })).rejects.toThrow(/container exited with code 1[\s\S]*startup failed/);
  });

  // Verify that the VITEST guard in installBrokerShutdownHook prevents signal
  // handler installation in test environments. If the guard is removed, the
  // SIGTERM/SIGINT handlers leak into vitest's fork worker and cause an
  // unhandled rejection ("Closing rpc while onUserConsoleLog was pending").
  it('does not install process signal handlers when running under a vitest worker', async () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('VITEST_WORKER_ID', '1');
    vi.stubEnv('NODE_ENV', 'development');
    const onceSpy = vi.spyOn(process, 'once');

    const { ensureBrokerRunning } = await import('@/lib/browser-broker/container-lifecycle');

    await ensureBrokerRunning();

    const signalCalls = onceSpy.mock.calls.filter(
      ([signal]) => signal === 'SIGTERM' || signal === 'SIGINT',
    );
    expect(signalCalls).toHaveLength(0);
  });

  it('removes installed process signal handlers when the broker stops', async () => {
    const removeListenerSpy = vi.spyOn(process, 'removeListener');
    const sigintHook = vi.fn();
    const sigtermHook = vi.fn();
    (globalThis as typeof globalThis & {
      __tamtamBrowserBrokerShutdownHookInstalled?: boolean;
      __tamtamBrowserBrokerShutdownHooks?: Partial<Record<'SIGINT' | 'SIGTERM', () => void>>;
    }).__tamtamBrowserBrokerShutdownHookInstalled = true;
    (globalThis as typeof globalThis & {
      __tamtamBrowserBrokerShutdownHooks?: Partial<Record<'SIGINT' | 'SIGTERM', () => void>>;
    }).__tamtamBrowserBrokerShutdownHooks = {
      SIGINT: sigintHook,
      SIGTERM: sigtermHook,
    };

    const { ensureBrokerRunning, stopBroker } = await import('@/lib/browser-broker/container-lifecycle');

    await ensureBrokerRunning();
    await stopBroker();

    expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', sigintHook);
    expect(removeListenerSpy).toHaveBeenCalledWith('SIGTERM', sigtermHook);
    expect((globalThis as typeof globalThis & { __tamtamBrowserBrokerShutdownHookInstalled?: unknown }).__tamtamBrowserBrokerShutdownHookInstalled).toBeUndefined();
    expect((globalThis as typeof globalThis & { __tamtamBrowserBrokerShutdownHooks?: unknown }).__tamtamBrowserBrokerShutdownHooks).toBeUndefined();
  });

  it('uses silent detached cleanup from installed process signal handlers', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('VITEST_WORKER_ID', undefined);
    vi.stubEnv('VITEST_POOL_ID', undefined);

    const vitestGlobal = (globalThis as typeof globalThis & { __vitest_worker__?: unknown }).__vitest_worker__;
    delete (globalThis as typeof globalThis & { __vitest_worker__?: unknown }).__vitest_worker__;

    const unrefMock = vi.fn();
    const spawnMock = vi.fn(() => ({ unref: unrefMock }));
    vi.doMock('child_process', async (importOriginal) => ({
      ...await importOriginal<typeof import('child_process')>(),
      spawn: spawnMock,
    }));

    const hooks: Partial<Record<'SIGINT' | 'SIGTERM', () => void>> = {};
    const onceSpy = vi.spyOn(process, 'once').mockImplementation(((signal: NodeJS.Signals, listener: NodeJS.SignalsListener) => {
      if (signal === 'SIGINT' || signal === 'SIGTERM') {
        hooks[signal] = listener as () => void;
      }
      return process;
    }) as typeof process.once);

    try {
      const { ensureBrokerRunning } = await import('@/lib/browser-broker/container-lifecycle');

      await ensureBrokerRunning();
      const rmCallsBeforeSignal = runShellMock.mock.calls.filter(([, args]) => args[0] === 'rm' && args[1] === '-f').length;

      expect(onceSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(onceSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

      hooks.SIGTERM?.();

      expect(spawnMock).toHaveBeenCalledWith('docker', ['rm', '-f', 'tamtam-playwright-broker-4321'], {
        detached: true,
        stdio: 'ignore',
      });
      expect(unrefMock).toHaveBeenCalled();
      expect(runShellMock.mock.calls.filter(([, args]) => args[0] === 'rm' && args[1] === '-f')).toHaveLength(rmCallsBeforeSignal);
      expect((globalThis as typeof globalThis & { __tamtamBrowserBroker?: unknown }).__tamtamBrowserBroker).toBeUndefined();
      expect((globalThis as typeof globalThis & { __tamtamBrowserBrokerStarting?: unknown }).__tamtamBrowserBrokerStarting).toBeUndefined();
    } finally {
      if (vitestGlobal !== undefined) {
        (globalThis as typeof globalThis & { __vitest_worker__?: unknown }).__vitest_worker__ = vitestGlobal;
      }
    }
  });
});
