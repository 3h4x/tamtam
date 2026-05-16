import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = vi.fn();
  return child;
}

// The watchdog only touches `kill`; we satisfy the ChildProcess shape with a
// double cast so the fake doesn't have to stub stdin/stdout/etc.
const asChild = (c: FakeChild) => c as unknown as ChildProcess;

describe('installInactivityWatchdog', () => {
  let originalEnv: string | undefined;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalEnv = process.env.SHIM_INACTIVITY_TIMEOUT_MS;
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    stderrWriteSpy.mockRestore();
    if (originalEnv === undefined) delete process.env.SHIM_INACTIVITY_TIMEOUT_MS;
    else process.env.SHIM_INACTIVITY_TIMEOUT_MS = originalEnv;
  });

  it('SIGTERMs the child after the configured idle window', async () => {
    const { installInactivityWatchdog } = await import('@/scripts/shim-utils');
    const child = makeFakeChild();
    const wd = installInactivityWatchdog(asChild(child), { shimName: 'test', timeoutMs: 1000, startupGraceMs: 0 });
    vi.advanceTimersByTime(1500);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(wd.timedOut()).toBe(true);
    wd.dispose();
  });

  it('escalates to SIGKILL after the grace window if the child is still alive', async () => {
    const { installInactivityWatchdog } = await import('@/scripts/shim-utils');
    const child = makeFakeChild();
    const wd = installInactivityWatchdog(asChild(child), { shimName: 'test', timeoutMs: 1000, startupGraceMs: 0 });
    vi.advanceTimersByTime(1500); // SIGTERM fires
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(6000); // > 5s grace
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    wd.dispose();
  });

  it('rearms the timer on markActivity()', async () => {
    const { installInactivityWatchdog } = await import('@/scripts/shim-utils');
    const child = makeFakeChild();
    const wd = installInactivityWatchdog(asChild(child), { shimName: 'test', timeoutMs: 1000, startupGraceMs: 0 });
    vi.advanceTimersByTime(900);
    wd.markActivity();
    vi.advanceTimersByTime(900); // total 1800 since start, but only 900 since last activity
    expect(child.kill).not.toHaveBeenCalled();
    expect(wd.timedOut()).toBe(false);
    vi.advanceTimersByTime(500); // 1400 since last activity → fires
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    wd.dispose();
  });

  it('disabled when timeout <= 0 (env override)', async () => {
    process.env.SHIM_INACTIVITY_TIMEOUT_MS = '0';
    vi.resetModules();
    const { installInactivityWatchdog } = await import('@/scripts/shim-utils');
    const child = makeFakeChild();
    const wd = installInactivityWatchdog(asChild(child), { shimName: 'test' });
    vi.advanceTimersByTime(60_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(wd.timedOut()).toBe(false);
    wd.dispose();
  });

  it('onTimeout callback runs once when watchdog fires', async () => {
    const { installInactivityWatchdog } = await import('@/scripts/shim-utils');
    const child = makeFakeChild();
    const onTimeout = vi.fn();
    const wd = installInactivityWatchdog(asChild(child), { shimName: 'test', timeoutMs: 1000, startupGraceMs: 0, onTimeout });
    vi.advanceTimersByTime(2500);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0][0]).toMatchObject({ timeoutMs: 1000 });
    wd.dispose();
  });

  it('waits through the default startup grace before killing a silent child', async () => {
    const { installInactivityWatchdog } = await import('@/scripts/shim-utils');
    const child = makeFakeChild();
    const wd = installInactivityWatchdog(asChild(child), { shimName: 'test', timeoutMs: 1000 });
    vi.advanceTimersByTime(4500);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    wd.dispose();
  });
});

describe('installFetchInactivityWatchdog', () => {
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    stderrWriteSpy.mockRestore();
  });

  it('waits through the default startup grace before aborting a silent fetch', async () => {
    const { installFetchInactivityWatchdog } = await import('@/scripts/shim-utils');
    const abort = vi.fn();
    const wd = installFetchInactivityWatchdog(abort, { shimName: 'test', timeoutMs: 1000 });
    vi.advanceTimersByTime(4500);
    expect(abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(wd.timedOut()).toBe(true);
    wd.dispose();
  });

  it('aborts the fetch when idle past the timeout', async () => {
    const { installFetchInactivityWatchdog } = await import('@/scripts/shim-utils');
    const abort = vi.fn();
    const wd = installFetchInactivityWatchdog(abort, { shimName: 'test', timeoutMs: 1000, startupGraceMs: 0 });
    vi.advanceTimersByTime(1500);
    expect(abort).toHaveBeenCalled();
    expect(wd.timedOut()).toBe(true);
    wd.dispose();
  });

  it('rearms on markActivity()', async () => {
    const { installFetchInactivityWatchdog } = await import('@/scripts/shim-utils');
    const abort = vi.fn();
    const wd = installFetchInactivityWatchdog(abort, { shimName: 'test', timeoutMs: 1000, startupGraceMs: 0 });
    vi.advanceTimersByTime(900);
    wd.markActivity();
    vi.advanceTimersByTime(900);
    expect(abort).not.toHaveBeenCalled();
    wd.dispose();
  });
});
