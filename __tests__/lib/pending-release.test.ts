import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('pending-release queue', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let setPendingRelease: typeof import('@/lib/pipeline/pending-release').setPendingRelease;
  let getPendingRelease: typeof import('@/lib/pipeline/pending-release').getPendingRelease;
  let clearPendingRelease: typeof import('@/lib/pipeline/pending-release').clearPendingRelease;
  let listPendingReleaseProjects: typeof import('@/lib/pipeline/pending-release').listPendingReleaseProjects;
  let drainPendingRelease: typeof import('@/lib/pipeline/pending-release').drainPendingRelease;
  let startReleaseMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    startReleaseMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'rel-1' });
    vi.doMock('@/lib/pipeline/start-release', () => ({ startRelease: startReleaseMock }));

    const mod = await import('@/lib/pipeline/pending-release');
    setPendingRelease = mod.setPendingRelease;
    getPendingRelease = mod.getPendingRelease;
    clearPendingRelease = mod.clearPendingRelease;
    listPendingReleaseProjects = mod.listPendingReleaseProjects;
    drainPendingRelease = mod.drainPendingRelease;
  });

  afterEach(() => { vi.resetModules(); });

  it('starts unset', () => {
    expect(getPendingRelease('proj')).toBe(false);
  });

  it('set / get / clear roundtrip', () => {
    setPendingRelease('proj');
    expect(getPendingRelease('proj')).toBe(true);
    clearPendingRelease('proj');
    expect(getPendingRelease('proj')).toBe(false);
  });

  it('idempotent: setting twice yields a single flag', () => {
    setPendingRelease('proj');
    setPendingRelease('proj');
    expect(listPendingReleaseProjects()).toEqual(['proj']);
  });

  it('keeps multiple projects independent', () => {
    setPendingRelease('proj-a');
    setPendingRelease('proj-b');
    expect(listPendingReleaseProjects().sort()).toEqual(['proj-a', 'proj-b']);
    clearPendingRelease('proj-a');
    expect(listPendingReleaseProjects()).toEqual(['proj-b']);
  });

  it('drain calls startRelease and clears the flag', async () => {
    setPendingRelease('proj');
    await drainPendingRelease('proj');
    expect(startReleaseMock).toHaveBeenCalledOnce();
    expect(startReleaseMock).toHaveBeenCalledWith('proj');
    expect(getPendingRelease('proj')).toBe(false);
  });

  it('drain is a no-op when no flag is set', async () => {
    await drainPendingRelease('proj');
    expect(startReleaseMock).not.toHaveBeenCalled();
  });

  it('drain swallows non-OK release results without surfacing them', async () => {
    startReleaseMock.mockResolvedValueOnce({ ok: false, status: 400, detail: 'Nothing to release' });
    setPendingRelease('proj');
    await expect(drainPendingRelease('proj')).resolves.toBeUndefined();
    expect(getPendingRelease('proj')).toBe(false);
  });

  it('keeps the queue when drain hits a temporary global-pause block', async () => {
    startReleaseMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      detail: 'Jobs are paused globally. Turn the switch back on in Settings to start a release.',
    });
    setPendingRelease('proj');
    await expect(drainPendingRelease('proj')).resolves.toBeUndefined();
    expect(getPendingRelease('proj')).toBe(true);
  });

  it('keeps the queue when drain hits a temporary project-pause block', async () => {
    startReleaseMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      detail: 'project paused',
    });
    setPendingRelease('proj');
    await expect(drainPendingRelease('proj')).resolves.toBeUndefined();
    expect(getPendingRelease('proj')).toBe(true);
  });

  it('keeps the queue when drain returns a retryable startup failure', async () => {
    startReleaseMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      detail: 'Failed to create release job',
      retryable: true,
    });
    setPendingRelease('proj');
    await expect(drainPendingRelease('proj')).resolves.toBeUndefined();
    expect(getPendingRelease('proj')).toBe(true);
  });

  it('keeps the queue when drain throws before release start is confirmed', async () => {
    startReleaseMock.mockRejectedValueOnce(new Error('pm2 start failed'));
    setPendingRelease('proj');
    await expect(drainPendingRelease('proj')).resolves.toBeUndefined();
    expect(getPendingRelease('proj')).toBe(true);
  });

  describe('shouldKeepPendingRelease', () => {
    let shouldKeepPendingRelease: typeof import('@/lib/pipeline/pending-release').shouldKeepPendingRelease;
    beforeEach(async () => {
      const mod = await import('@/lib/pipeline/pending-release');
      shouldKeepPendingRelease = mod.shouldKeepPendingRelease;
    });

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
      expect(shouldKeepPendingRelease({ ok: false, status: 500, retryable: true, detail: 'pm2 down' })).toBe(true);
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
