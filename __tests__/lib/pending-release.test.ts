import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted shared mock factories. Top-level vi.mock() lets every test reuse the
// same compiled module graph for pending-release — much faster than calling
// vi.resetModules() + vi.doMock() per test.
// ─────────────────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  return {
    sharedHandle: null as TestDbHandle | null,
    startReleaseMock: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({
  get db() {
    return mocks.sharedHandle!.db;
  },
  schema,
}));

vi.mock('@/lib/pipeline/start-release', () => ({
  startRelease: (...args: unknown[]) => mocks.startReleaseMock(...args),
}));
vi.mock('@/lib/workflows/dispatch-release', () => ({
  dispatchReleaseWorkflow: (...args: unknown[]) => mocks.startReleaseMock(...args),
}));

// Single top-level import — all tests below share this resolved module graph.
import {
  setPendingRelease,
  getPendingRelease,
  clearPendingRelease,
  listPendingReleaseProjects,
  drainPendingRelease,
  shouldKeepPendingRelease,
} from '@/lib/pipeline/pending-release';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
}

async function waitForPending(project: string, expected: boolean): Promise<void> {
  await vi.waitFor(async () => {
    const actual = await getPendingRelease(project);
    if (actual !== expected) throw new Error(`pending(${project}) not yet ${expected}`);
  }, { interval: 1, timeout: 1000 });
}

async function waitForListed(expected: string[]): Promise<void> {
  await vi.waitFor(async () => {
    const actual = (await listPendingReleaseProjects()).sort();
    const want = [...expected].sort();
    if (actual.length !== want.length || actual.some((v, i) => v !== want[i])) {
      throw new Error(`list not yet ${JSON.stringify(want)} (got ${JSON.stringify(actual)})`);
    }
  }, { interval: 1, timeout: 1000 });
}

describe('pending-release queue', () => {
  beforeAll(async () => {
    mocks.sharedHandle = await createTestPgDbEmpty();
    await applyDdl(mocks.sharedHandle);
  });

  afterAll(async () => {
    try {
      await mocks.sharedHandle![Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await mocks.sharedHandle!.db.execute(sql.raw('TRUNCATE settings'));
    mocks.startReleaseMock.mockReset();
    mocks.startReleaseMock.mockResolvedValue({ ok: true, jobId: 'rel-1' });
  });

  it('starts unset', async () => {
    expect(await getPendingRelease('proj')).toBe(false);
  });

  it('set / get / clear roundtrip', async () => {
    setPendingRelease('proj');
    await waitForPending('proj', true);
    clearPendingRelease('proj');
    await waitForPending('proj', false);
  });

  it('idempotent: setting twice yields a single flag', async () => {
    setPendingRelease('proj');
    setPendingRelease('proj');
    await waitForListed(['proj']);
  });

  it('keeps multiple projects independent', async () => {
    setPendingRelease('proj-a');
    setPendingRelease('proj-b');
    await waitForListed(['proj-a', 'proj-b']);
    clearPendingRelease('proj-a');
    await waitForListed(['proj-b']);
  });

  it('drain calls startRelease and clears the flag', async () => {
    setPendingRelease('proj');
    await waitForPending('proj', true);
    await drainPendingRelease('proj');
    expect(mocks.startReleaseMock).toHaveBeenCalledOnce();
    expect(mocks.startReleaseMock).toHaveBeenCalledWith('proj');
    await waitForPending('proj', false);
  });

  it('drain is a no-op when no flag is set', async () => {
    await drainPendingRelease('proj');
    expect(mocks.startReleaseMock).not.toHaveBeenCalled();
  });

  it('drain swallows non-OK release results without surfacing them', async () => {
    mocks.startReleaseMock.mockResolvedValueOnce({ ok: false, status: 400, detail: 'Nothing to release' });
    setPendingRelease('proj');
    await waitForPending('proj', true);
    await expect(drainPendingRelease('proj')).resolves.toBeUndefined();
    await waitForPending('proj', false);
  });

  it('keeps the queue when drain hits a temporary global-pause block', async () => {
    mocks.startReleaseMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      detail: 'Jobs are paused globally. Turn the switch back on in Settings to start a release.',
    });
    setPendingRelease('proj');
    await waitForPending('proj', true);
    await expect(drainPendingRelease('proj')).resolves.toBeUndefined();
    await waitForPending('proj', true);
  });

  it('keeps the queue when drain hits a temporary project-pause block', async () => {
    mocks.startReleaseMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      detail: 'project paused',
    });
    setPendingRelease('proj');
    await waitForPending('proj', true);
    await expect(drainPendingRelease('proj')).resolves.toBeUndefined();
    await waitForPending('proj', true);
  });

  it('keeps the queue when drain returns a retryable startup failure', async () => {
    mocks.startReleaseMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      detail: 'Failed to create release job',
      retryable: true,
    });
    setPendingRelease('proj');
    await waitForPending('proj', true);
    await expect(drainPendingRelease('proj')).resolves.toBeUndefined();
    await waitForPending('proj', true);
  });

  it('keeps the queue when drain throws before release start is confirmed', async () => {
    mocks.startReleaseMock.mockRejectedValueOnce(new Error('spawn failed'));
    setPendingRelease('proj');
    await waitForPending('proj', true);
    await expect(drainPendingRelease('proj')).resolves.toBeUndefined();
    await waitForPending('proj', true);
  });

  describe('shouldKeepPendingRelease', () => {
    it('drops the flag for "Nothing to release"', () => {
      expect(shouldKeepPendingRelease({ ok: false, status: 400, detail: 'Nothing to release — no changes' })).toBe(false);
    });
    it('drops the flag for project-not-found', () => {
      expect(shouldKeepPendingRelease({ ok: false, status: 404, detail: 'project not found' })).toBe(false);
    });
    it('keeps the flag for budget block (429)', () => {
      expect(shouldKeepPendingRelease({ ok: false, status: 429, detail: 'budget' })).toBe(true);
    });
    it('keeps the flag for retryable startup failures', () => {
      expect(shouldKeepPendingRelease({ ok: false, status: 500, retryable: true, detail: 'spawn unavailable' })).toBe(true);
    });
    it('keeps the flag for "Pipeline already running" (409)', () => {
      expect(shouldKeepPendingRelease({ ok: false, status: 409, detail: 'Pipeline already running for proj' })).toBe(true);
    });
    it('keeps the flag for project paused (409)', () => {
      expect(shouldKeepPendingRelease({ ok: false, status: 409, detail: 'project paused' })).toBe(true);
    });
    it('drops the flag for unrelated 409s', () => {
      expect(shouldKeepPendingRelease({ ok: false, status: 409, detail: 'something else' })).toBe(false);
    });
    it('drops the flag on success', () => {
      expect(shouldKeepPendingRelease({ ok: true })).toBe(false);
    });
  });
});
