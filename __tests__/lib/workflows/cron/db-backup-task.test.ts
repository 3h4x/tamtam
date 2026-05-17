import { describe, it, expect, vi } from 'vitest';
import { handleDbBackup } from '@/lib/workflows/cron/db-backup-task';

describe('handleDbBackup', () => {
  const readConfig = () => ({ enabled: true, intervalMs: 15 * 60 * 1000 });

  it('creates a backup then prunes; passes the new path so prune can protect it', async () => {
    const createBackup = vi.fn().mockResolvedValue('/data/db/tamtam-now.pgdump');
    const pruneOld = vi.fn().mockResolvedValue(['tamtam-old.pgdump']);
    const enqueueNextFire = vi.fn().mockResolvedValue(undefined);
    const now = vi.fn().mockReturnValue(1_000_000_000_000);

    const r = await handleDbBackup({ createBackup, pruneOld, enqueueNextFire, readConfig, now });

    expect(r.ran).toBe(true);
    expect(r.backupPath).toBe('/data/db/tamtam-now.pgdump');
    expect(r.pruned).toEqual(['tamtam-old.pgdump']);
    expect(r.error).toBeUndefined();
    // Regression #182: prune must receive the new dump path so callers can
    // protect it via `protectedNames` (otherwise keepRecent=0 prunes it).
    expect(pruneOld).toHaveBeenCalledWith('/data/db/tamtam-now.pgdump');
    // 15-minute reenqueue
    expect(r.nextFireAt.getTime()).toBe(1_000_000_000_000 + 15 * 60 * 1000);
    expect(enqueueNextFire).toHaveBeenCalledWith(r.nextFireAt);
  });

  it('reports backup failure and still reenqueues', async () => {
    const createBackup = vi.fn().mockRejectedValue(new Error('pg_dump exit 1'));
    const pruneOld = vi.fn();
    const enqueueNextFire = vi.fn().mockResolvedValue(undefined);

    const r = await handleDbBackup({ createBackup, pruneOld, enqueueNextFire, readConfig });

    expect(r.ran).toBe(false);
    expect(r.error).toMatch(/pg_dump exit 1/);
    expect(pruneOld).not.toHaveBeenCalled();
    // Even on failure, chain stays alive.
    expect(enqueueNextFire).toHaveBeenCalled();
  });

  it('treats prune failure as non-fatal (backup still ran)', async () => {
    const createBackup = vi.fn().mockResolvedValue('/data/db/tamtam-now.pgdump');
    const pruneOld = vi.fn().mockRejectedValue(new Error('rmSync failed'));
    const enqueueNextFire = vi.fn().mockResolvedValue(undefined);

    const r = await handleDbBackup({ createBackup, pruneOld, enqueueNextFire, readConfig });

    expect(r.ran).toBe(true);
    expect(r.backupPath).toBe('/data/db/tamtam-now.pgdump');
    expect(r.error).toMatch(/prune failed.*rmSync/);
    expect(enqueueNextFire).toHaveBeenCalled();
  });
});
