import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createDatabaseBackup,
  listBackupFiles,
  pruneBackupFiles,
  selectBackupsToPrune,
  type BackupFileEntry,
} from '@/lib/db/backup';

const { execMock, mkdirSyncMock, readdirSyncMock, rmSyncMock, statSyncMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  mkdirSyncMock: vi.fn<(path: string, options?: { recursive?: boolean }) => void>(),
  readdirSyncMock: vi.fn<() => string[]>(() => []),
  rmSyncMock: vi.fn<(path: string, options?: { force?: boolean }) => void>(),
  statSyncMock: vi.fn<(path: string) => { mtimeMs: number }>(),
}));

vi.mock('@/lib/shared/shell', () => ({
  exec: execMock,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: mkdirSyncMock,
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
    mkdirSyncMock.mockReset();
    execMock.mockReset();
    execMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('passes localhost, password, and URL options to pg_dump without putting the password in args', async () => {
    process.env.DATABASE_URL = 'postgres://tamtam:p%40ss@localhost:5432/tamtam?sslmode=require&connect_timeout=7&application_name=tamtam-backup';

    await createDatabaseBackup('/tmp/tamtam/backups/tamtam-20260514-1200.pgdump');

    expect(mkdirSyncMock).toHaveBeenCalledWith('/tmp/tamtam/backups', { recursive: true });
    expect(execMock).toHaveBeenCalledWith('pg_dump', [
      '--format=custom',
      '--file=/tmp/tamtam/backups/tamtam-20260514-1200.pgdump',
      '--dbname=tamtam',
      '--host=localhost',
      '--port=5432',
      '--username=tamtam',
    ], {
      timeout: 120_000,
      env: {
        PGPASSWORD: 'p@ss',
        PGSSLMODE: 'require',
        PGCONNECT_TIMEOUT: '7',
        PGAPPNAME: 'tamtam-backup',
      },
    });
    expect(JSON.stringify(execMock.mock.calls[0][1])).not.toContain('p@ss');
  });

  it('keeps the newest backups and one older backup per week', () => {
    const entries = [
      backup('tamtam-20260513-1200.pgdump', 11),
      backup('tamtam-20260512-1200.pgdump', 10),
      backup('tamtam-20260511-1200.pgdump', 9),
      backup('tamtam-20260505-1200.pgdump', 8),
      backup('tamtam-20260504-1200.pgdump', 7),
      backup('tamtam-20260428-1200.pgdump', 6),
      backup('tamtam-20260427-1200.pgdump', 5),
      backup('tamtam-20260420-1200.pgdump', 4),
    ];

    const pruned = selectBackupsToPrune(entries, { keepRecent: 2, keepWeekly: 2 });

    expect(pruned).toEqual([
      'tamtam-20260504-1200.pgdump',
      'tamtam-20260428-1200.pgdump',
      'tamtam-20260427-1200.pgdump',
      'tamtam-20260420-1200.pgdump',
    ]);
  });

  it('keeps only the configured newest backups when weekly retention is disabled', () => {
    const entries = [
      backup('tamtam-20260513-1200.pgdump', 3),
      backup('tamtam-20260512-1200.pgdump', 2),
      backup('tamtam-20260511-1200.pgdump', 1),
    ];

    expect(selectBackupsToPrune(entries, { keepRecent: 1, keepWeekly: 0 })).toEqual([
      'tamtam-20260512-1200.pgdump',
      'tamtam-20260511-1200.pgdump',
    ]);
  });

  it('never prunes protected backup files', () => {
    const entries = [
      backup('tamtam-20260513-1200.pgdump', 3),
      backup('tamtam-20260512-1200.pgdump', 2),
      backup('tamtam-20260511-1200.pgdump', 1),
    ];

    expect(selectBackupsToPrune(entries, {
      keepRecent: 0,
      keepWeekly: 0,
      protectedNames: ['tamtam-20260513-1200.pgdump'],
    })).toEqual([
      'tamtam-20260512-1200.pgdump',
      'tamtam-20260511-1200.pgdump',
    ]);
  });

  it('does not let the protected current backup consume a weekly retention slot', () => {
    const entries = [
      backup('tamtam-20260513-1200.pgdump', 4),
      backup('tamtam-20260512-1200.pgdump', 3),
      backup('tamtam-20260505-1200.pgdump', 2),
      backup('tamtam-20260428-1200.pgdump', 1),
    ];

    expect(selectBackupsToPrune(entries, {
      keepRecent: 0,
      keepWeekly: 2,
      protectedNames: ['tamtam-20260513-1200.pgdump'],
    })).toEqual([
      'tamtam-20260428-1200.pgdump',
    ]);
  });

  it('prunes only matching pgdump files and ignores unrelated files in the backup directory', () => {
    readdirSyncMock.mockReturnValue([
      'tamtam-20260513-1200.pgdump',
      'tamtam-20260512-1200.pgdump',
      'unrelated.txt',
      'tamtam-20260511.bak', // wrong extension, ignored
    ]);
    statSyncMock.mockImplementation((path: string) => ({
      mtimeMs: path.endsWith('20260513-1200.pgdump')
        ? Date.UTC(2026, 4, 13, 12, 0)
        : Date.UTC(2026, 4, 12, 12, 0),
    }));

    const pruned = pruneBackupFiles('/tmp/backups', { keepRecent: 1, keepWeekly: 0 });

    expect(pruned).toEqual(['tamtam-20260512-1200.pgdump']);
    expect(rmSyncMock.mock.calls).toEqual([
      ['/tmp/backups/tamtam-20260512-1200.pgdump', { force: true }],
    ]);
  });

  it('ignores backup files that disappear before they can be statted', () => {
    readdirSyncMock.mockReturnValue([
      'tamtam-20260513-1200.pgdump',
      'tamtam-20260512-1200.pgdump',
    ]);
    statSyncMock.mockImplementation((path: string) => {
      if (path.endsWith('20260513-1200.pgdump')) {
        return { mtimeMs: Date.UTC(2026, 4, 13, 12, 0) };
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    expect(listBackupFiles('/tmp/backups')).toEqual([
      {
        name: 'tamtam-20260513-1200.pgdump',
        mtimeMs: Date.UTC(2026, 4, 13, 12, 0),
      },
    ]);
  });
});
