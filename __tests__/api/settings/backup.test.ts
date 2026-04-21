import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/settings/backup', () => {
  beforeEach(() => {
    vi.resetModules();
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
    expect(mockBackup).toHaveBeenCalledOnce();
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('generates filename with zero-padded month and day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-05T09:03:00Z'));

    const mockBackup = vi.fn().mockResolvedValue(undefined);
    vi.doMock('better-sqlite3', () => ({
      default: class {
        backup = mockBackup;
        close = vi.fn();
      },
    }));

    const { POST } = await import('@/app/api/settings/backup/route');
    const req = new NextRequest('http://localhost/api/settings/backup', { method: 'POST' });
    const res = await POST(req);
    const data = await res.json();

    expect(data.filename).toMatch(/^tamtam-20250105-\d{4}\.db$/);
  });
});
