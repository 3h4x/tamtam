import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('startProjectCommit', () => {
  let setProjectPushResultMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    setProjectPushResultMock = vi.fn();
    checkCliStartGateMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      detail: 'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.',
    });

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp' }),
      setProjectPushResult: setProjectPushResultMock,
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
      acquireLock: vi.fn(),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: vi.fn(),
      markDone: vi.fn(),
      updateJob: vi.fn(),
      listJobs: vi.fn().mockReturnValue([]),
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 429 when every enabled provider is over budget', async () => {
    const { startProjectCommit } = await import('@/lib/pipeline/start-commit');
    const result = await startProjectCommit('proj');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(429);
    expect(setProjectPushResultMock).toHaveBeenCalledWith(
      'proj',
      'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.',
    );
  });
});
