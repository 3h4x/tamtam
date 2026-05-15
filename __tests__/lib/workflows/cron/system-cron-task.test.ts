import { describe, it, expect, vi } from 'vitest';
import {
  handleSystemCron,
  SYSTEM_CRON_DAY_MS,
  type SystemCronDeps,
} from '@/lib/workflows/cron/system-cron-task';

function makeDeps(overrides: Partial<SystemCronDeps> = {}): SystemCronDeps {
  return {
    runRetentionCleanup: vi.fn(async () => {}),
    enqueueNextFire: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('handleSystemCron', () => {
  const NOW = 1_700_000_000_000;

  it('runs cleanup and re-enqueues exactly one day out on success', async () => {
    const deps = makeDeps();
    const r = await handleSystemCron({ ...deps, now: () => NOW });
    expect(r.cleanupOk).toBe(true);
    expect(r.cleanupError).toBeUndefined();
    expect(deps.runRetentionCleanup).toHaveBeenCalledTimes(1);
    expect(deps.enqueueNextFire).toHaveBeenCalledTimes(1);
    const callArgs = (deps.enqueueNextFire as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((callArgs[0] as Date).getTime()).toBe(NOW + SYSTEM_CRON_DAY_MS);
  });

  it('still re-enqueues when cleanup throws (chain must keep ticking)', async () => {
    const deps = makeDeps({
      runRetentionCleanup: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    const r = await handleSystemCron({ ...deps, now: () => NOW });
    expect(r.cleanupOk).toBe(false);
    expect(r.cleanupError).toBe('disk full');
    expect(deps.enqueueNextFire).toHaveBeenCalledTimes(1);
  });

  it('captures non-Error throw as String()', async () => {
    const deps = makeDeps({
      runRetentionCleanup: vi.fn(async () => {
        throw 'string panic';
      }),
    });
    const r = await handleSystemCron({ ...deps, now: () => NOW });
    expect(r.cleanupError).toBe('string panic');
  });
});
