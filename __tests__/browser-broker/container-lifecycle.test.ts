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
    }).__tamtamBrowserBrokerStarting;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('honors a configured broker image override', async () => {
    const { ensureBrokerRunning } = await import('@/lib/browser-broker/container-lifecycle');

    const handle = await ensureBrokerRunning({ image: 'custom/broker:1' });

    expect(handle.url).toBe('http://127.0.0.1:4321');
    expect(runShellMock.mock.calls.some(([, args]) => args[0] === 'image' && args[1] === 'inspect' && args[2] === 'custom/broker:1')).toBe(true);
    expect(runShellMock.mock.calls.some(([, args]) => args[0] === 'pull' && args[1] === 'custom/broker:1')).toBe(false);
    expect(runShellMock.mock.calls.some(([, args]) => args[0] === 'run' && args.includes('custom/broker:1'))).toBe(true);
  });

  it('defaults to the pinned broker image when no override is provided', async () => {
    const { ensureBrokerRunning } = await import('@/lib/browser-broker/container-lifecycle');

    await ensureBrokerRunning();

    expect(runShellMock.mock.calls.some(([, args]) => args[0] === 'image' && args[1] === 'inspect' && args[2] === 'mcr.microsoft.com/playwright:v1.59.1-noble')).toBe(true);
    expect(runShellMock.mock.calls.some(([, args]) => args[0] === 'run' && args.includes('mcr.microsoft.com/playwright:v1.59.1-noble'))).toBe(true);
  });
});
