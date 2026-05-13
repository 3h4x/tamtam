import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pruneBackupFiles, selectBackupsToPrune, type BackupFileEntry } from '@/lib/db/backup';

const { readdirSyncMock, rmSyncMock, statSyncMock } = vi.hoisted(() => ({
  readdirSyncMock: vi.fn<() => string[]>(() => []),
  rmSyncMock: vi.fn<(path: string, options?: { force?: boolean }) => void>(),
  statSyncMock: vi.fn<(path: string) => { mtimeMs: number }>(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readdirSync: readdirSyncMock,
    rmSync: rmSyncMock,
    statSync: statSyncMock,
  };
});

function backup(name: string, index: number): BackupFileEntry {
  return { name, mtimeMs: Date.UTC(2026, 0, index + 1) };
}

describe('db backup retention', () => {
  beforeEach(() => {
    readdirSyncMock.mockReset();
    rmSyncMock.mockReset();
    statSyncMock.mockReset();
  });

  it('keeps the newest backups and one older backup per week', () => {
    const entries = [
      backup('tamtam-20260513-1200.db', 11),
      backup('tamtam-20260512-1200.db', 10),
      backup('tamtam-20260511-1200.db', 9),
      backup('tamtam-20260505-1200.db', 8),
      backup('tamtam-20260504-1200.db', 7),
      backup('tamtam-20260428-1200.db', 6),
      backup('tamtam-20260427-1200.db', 5),
      backup('tamtam-20260420-1200.db', 4),
    ];

    const pruned = selectBackupsToPrune(entries, { keepRecent: 2, keepWeekly: 2 });

    expect(pruned).toEqual([
      'tamtam-20260504-1200.db',
      'tamtam-20260428-1200.db',
      'tamtam-20260427-1200.db',
      'tamtam-20260420-1200.db',
    ]);
  });

  it('keeps only the configured newest backups when weekly retention is disabled', () => {
    const entries = [
      backup('tamtam-20260513-1200.db', 3),
      backup('tamtam-20260512-1200.db', 2),
      backup('tamtam-20260511-1200.db', 1),
    ];

    expect(selectBackupsToPrune(entries, { keepRecent: 1, keepWeekly: 0 })).toEqual([
      'tamtam-20260512-1200.db',
      'tamtam-20260511-1200.db',
    ]);
  });

  it('never prunes protected backup files', () => {
    const entries = [
      backup('tamtam-20260513-1200.db', 3),
      backup('tamtam-20260512-1200.db', 2),
      backup('tamtam-20260511-1200.db', 1),
    ];

    expect(selectBackupsToPrune(entries, {
      keepRecent: 0,
      keepWeekly: 0,
      protectedNames: ['tamtam-20260513-1200.db'],
    })).toEqual([
      'tamtam-20260512-1200.db',
      'tamtam-20260511-1200.db',
    ]);
  });

  it('does not let the protected current backup consume a weekly retention slot', () => {
    const entries = [
      backup('tamtam-20260513-1200.db', 4),
      backup('tamtam-20260512-1200.db', 3),
      backup('tamtam-20260505-1200.db', 2),
      backup('tamtam-20260428-1200.db', 1),
    ];

    expect(selectBackupsToPrune(entries, {
      keepRecent: 0,
      keepWeekly: 2,
      protectedNames: ['tamtam-20260513-1200.db'],
    })).toEqual([
      'tamtam-20260428-1200.db',
    ]);
  });

  it('prunes sqlite sidecars together with the selected backup file', () => {
    readdirSyncMock.mockReturnValue([
      'tamtam-20260513-1200.db',
      'tamtam-20260512-1200.db',
      'tamtam-20260512-1200.db-wal',
      'tamtam-20260512-1200.db-shm',
    ]);
    statSyncMock.mockImplementation((path: string) => ({
      mtimeMs: path.endsWith('20260513-1200.db')
        ? Date.UTC(2026, 4, 13, 12, 0)
        : Date.UTC(2026, 4, 12, 12, 0),
    }));

    const pruned = pruneBackupFiles('/tmp/backups', { keepRecent: 1, keepWeekly: 0 });

    expect(pruned).toEqual(['tamtam-20260512-1200.db']);
    expect(rmSyncMock.mock.calls).toEqual([
      ['/tmp/backups/tamtam-20260512-1200.db', { force: true }],
      ['/tmp/backups/tamtam-20260512-1200.db-wal', { force: true }],
      ['/tmp/backups/tamtam-20260512-1200.db-shm', { force: true }],
    ]);
  });
});
