import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mockConfig = {
  backup_retention_count: 14,
  backup_retention_weekly_count: 8,
};
const readdirSyncMock = vi.fn<() => string[]>(() => []);
const rmSyncMock = vi.fn<(path: string, options?: { force?: boolean; recursive?: boolean }) => void>();
const statSyncMock = vi.fn<(path: string) => { mtimeMs: number }>();
describe('POST /api/settings/backup', () => {
  beforeEach(() => {
    vi.resetModules();
    mockConfig.backup_retention_count = 14;
    mockConfig.backup_retention_weekly_count = 8;
    readdirSyncMock.mockReset();
    readdirSyncMock.mockReturnValue([]);
    rmSyncMock.mockReset();
    statSyncMock.mockReset();
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ ...mockConfig }),
    }));
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        readdirSync: readdirSyncMock,
        rmSync: rmSyncMock,
        statSync: statSyncMock,
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('returns 500 when database file does not exist', async () => {
    vi.doMock('better-sqlite3', () => ({
      default: class {
        constructor() {
          throw new Error('SQLITE_CANTOPEN: unable to open database file');
        }
      },
    }));

    const { POST } = await import('@/app/api/settings/backup/route');
    const req = new NextRequest('http://localhost/api/settings/backup', { method: 'POST' });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('Backup failed');
    expect(data.error).toContain('SQLITE_CANTOPEN');
  });

  it('returns ok with filename and path on success', async () => {
    const mockBackup = vi.fn().mockResolvedValue(undefined);
    const mockClose = vi.fn();

    vi.doMock('better-sqlite3', () => ({
      default: class {
        backup = mockBackup;
        pragma = vi.fn((name: string) => name === 'integrity_check' ? [{ integrity_check: 'ok' }] : []);
        close = mockClose;
      },
    }));

    const { POST } = await import('@/app/api/settings/backup/route');
    const req = new NextRequest('http://localhost/api/settings/backup', { method: 'POST' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.filename).toMatch(/^tamtam-\d{8}-\d{4}\.db$/);
    expect(data.path).toContain(data.filename);
    expect(data.pruned).toEqual([]);
    expect(mockBackup).toHaveBeenCalledOnce();
    expect(mockClose).toHaveBeenCalledTimes(3);
  });

  it('generates filename with zero-padded month and day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-05T09:03:00Z'));

    const mockBackup = vi.fn().mockResolvedValue(undefined);
    vi.doMock('better-sqlite3', () => ({
      default: class {
        backup = mockBackup;
        pragma = vi.fn((name: string) => name === 'integrity_check' ? [{ integrity_check: 'ok' }] : []);
        close = vi.fn();
      },
    }));

    const { POST } = await import('@/app/api/settings/backup/route');
    const req = new NextRequest('http://localhost/api/settings/backup', { method: 'POST' });
    const res = await POST(req);
    const data = await res.json();

    expect(data.filename).toMatch(/^tamtam-20250105-\d{4}\.db$/);
  });

  it('returns 500 when backup integrity check fails', async () => {
    vi.useFakeTimers();
    const frozenNow = new Date('2025-01-05T09:03:00Z');
    vi.setSystemTime(frozenNow);
    const pad = (value: number) => String(value).padStart(2, '0');
    const currentFilename = `tamtam-${frozenNow.getFullYear()}${pad(frozenNow.getMonth() + 1)}${pad(frozenNow.getDate())}-${pad(frozenNow.getHours())}${pad(frozenNow.getMinutes())}.db`;
    const mockBackup = vi.fn().mockResolvedValue(undefined);
    let integrityChecks = 0;
    vi.doMock('better-sqlite3', () => ({
      default: class {
        backup = mockBackup;
        pragma = vi.fn((name: string) => {
          if (name !== 'integrity_check') return [];
          integrityChecks += 1;
          return integrityChecks === 1
            ? [{ integrity_check: 'ok' }]
            : [{ integrity_check: 'database disk image is malformed' }];
        });
        close = vi.fn();
      },
    }));

    const { POST } = await import('@/app/api/settings/backup/route');
    const req = new NextRequest('http://localhost/api/settings/backup', { method: 'POST' });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('integrity_check failed');
    expect(rmSyncMock).toHaveBeenCalledTimes(3);
    expect(String(rmSyncMock.mock.calls[0][0])).toContain(currentFilename);
    expect(rmSyncMock.mock.calls[0][1]).toEqual({ force: true });
    expect(String(rmSyncMock.mock.calls[1][0])).toContain(`${currentFilename}-wal`);
    expect(String(rmSyncMock.mock.calls[2][0])).toContain(`${currentFilename}-shm`);
  });

  it('keeps the newly created backup even when both retention settings are zero', async () => {
    vi.useFakeTimers();
    const frozenNow = new Date('2025-01-05T09:03:00Z');
    vi.setSystemTime(frozenNow);
    const pad = (value: number) => String(value).padStart(2, '0');
    const currentFilename = `tamtam-${frozenNow.getFullYear()}${pad(frozenNow.getMonth() + 1)}${pad(frozenNow.getDate())}-${pad(frozenNow.getHours())}${pad(frozenNow.getMinutes())}.db`;
    mockConfig.backup_retention_count = 0;
    mockConfig.backup_retention_weekly_count = 0;
    readdirSyncMock.mockReturnValue([
      currentFilename,
      'tamtam-20241229-0100.db',
    ]);
    statSyncMock.mockImplementation((path: string) => ({
      mtimeMs: path.endsWith(currentFilename)
        ? Date.UTC(2025, 0, 5, 9, 3)
        : Date.UTC(2024, 11, 29, 1, 0),
    }));

    vi.doMock('better-sqlite3', () => ({
      default: class {
        backup = vi.fn().mockResolvedValue(undefined);
        pragma = vi.fn((name: string) => name === 'integrity_check' ? [{ integrity_check: 'ok' }] : []);
        close = vi.fn();
      },
    }));

    const { POST } = await import('@/app/api/settings/backup/route');
    const req = new NextRequest('http://localhost/api/settings/backup', { method: 'POST' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.filename).toBe(currentFilename);
    expect(data.pruned).toEqual(['tamtam-20241229-0100.db']);
    expect(rmSyncMock).toHaveBeenCalledTimes(3);
    expect(String(rmSyncMock.mock.calls[0][0])).toContain('tamtam-20241229-0100.db');
    expect(String(rmSyncMock.mock.calls[1][0])).toContain('tamtam-20241229-0100.db-wal');
    expect(String(rmSyncMock.mock.calls[2][0])).toContain('tamtam-20241229-0100.db-shm');
  });

  it('keeps weekly older backups in addition to the protected current backup when recent retention is zero', async () => {
    vi.useFakeTimers();
    const frozenNow = new Date('2025-01-05T09:03:00Z');
    vi.setSystemTime(frozenNow);
    const pad = (value: number) => String(value).padStart(2, '0');
    const currentFilename = `tamtam-${frozenNow.getFullYear()}${pad(frozenNow.getMonth() + 1)}${pad(frozenNow.getDate())}-${pad(frozenNow.getHours())}${pad(frozenNow.getMinutes())}.db`;
    mockConfig.backup_retention_count = 0;
    mockConfig.backup_retention_weekly_count = 2;
    readdirSyncMock.mockReturnValue([
      currentFilename,
      'tamtam-20241230-0100.db',
      'tamtam-20241223-0100.db',
      'tamtam-20241216-0100.db',
    ]);
    statSyncMock.mockImplementation((path: string) => ({
      mtimeMs:
        path.endsWith(currentFilename) ? Date.UTC(2025, 0, 5, 9, 3)
        : path.endsWith('20241230-0100.db') ? Date.UTC(2024, 11, 30, 1, 0)
        : path.endsWith('20241223-0100.db') ? Date.UTC(2024, 11, 23, 1, 0)
        : Date.UTC(2024, 11, 16, 1, 0),
    }));

    vi.doMock('better-sqlite3', () => ({
      default: class {
        backup = vi.fn().mockResolvedValue(undefined);
        pragma = vi.fn((name: string) => name === 'integrity_check' ? [{ integrity_check: 'ok' }] : []);
        close = vi.fn();
      },
    }));

    const { POST } = await import('@/app/api/settings/backup/route');
    const req = new NextRequest('http://localhost/api/settings/backup', { method: 'POST' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.filename).toBe(currentFilename);
    expect(data.pruned).toEqual(['tamtam-20241216-0100.db']);
    expect(rmSyncMock).toHaveBeenCalledTimes(3);
    expect(String(rmSyncMock.mock.calls[0][0])).toContain('tamtam-20241216-0100.db');
    expect(String(rmSyncMock.mock.calls[1][0])).toContain('tamtam-20241216-0100.db-wal');
    expect(String(rmSyncMock.mock.calls[2][0])).toContain('tamtam-20241216-0100.db-shm');
  });

  it('prunes backup sidecars together with the selected backup file', async () => {
    vi.useFakeTimers();
    const frozenNow = new Date('2025-01-05T09:03:00Z');
    vi.setSystemTime(frozenNow);
    const pad = (value: number) => String(value).padStart(2, '0');
    const currentFilename = `tamtam-${frozenNow.getFullYear()}${pad(frozenNow.getMonth() + 1)}${pad(frozenNow.getDate())}-${pad(frozenNow.getHours())}${pad(frozenNow.getMinutes())}.db`;
    mockConfig.backup_retention_count = 1;
    mockConfig.backup_retention_weekly_count = 0;
    readdirSyncMock.mockReturnValue([
      currentFilename,
      'tamtam-20241229-0100.db',
      'tamtam-20241229-0100.db-wal',
      'tamtam-20241229-0100.db-shm',
    ]);
    statSyncMock.mockImplementation((path: string) => ({
      mtimeMs: path.endsWith(currentFilename)
        ? Date.UTC(2025, 0, 5, 9, 3)
        : Date.UTC(2024, 11, 29, 1, 0),
    }));

    vi.doMock('better-sqlite3', () => ({
      default: class {
        backup = vi.fn().mockResolvedValue(undefined);
        pragma = vi.fn((name: string) => name === 'integrity_check' ? [{ integrity_check: 'ok' }] : []);
        close = vi.fn();
      },
    }));

    const { POST } = await import('@/app/api/settings/backup/route');
    const req = new NextRequest('http://localhost/api/settings/backup', { method: 'POST' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pruned).toEqual(['tamtam-20241229-0100.db']);
    expect(rmSyncMock.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([
      expect.stringContaining('tamtam-20241229-0100.db'),
      expect.stringContaining('tamtam-20241229-0100.db-wal'),
      expect.stringContaining('tamtam-20241229-0100.db-shm'),
    ]));
    expect(rmSyncMock).toHaveBeenCalledTimes(3);
  });
});
