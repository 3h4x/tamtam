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
    vi.doMock('@/lib/browser-broker/port-allocator', () => ({
      allocatePort: allocatePortMock,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
  });

  afterEach(() => {
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
});
