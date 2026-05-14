import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'path';

describe('scripts/db-restore.js', () => {
  let existsSyncMock: ReturnType<typeof vi.fn>;
  let spawnSyncMock: ReturnType<typeof vi.fn>;
  let statSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    existsSyncMock = vi.fn().mockReturnValue(true);
    spawnSyncMock = vi.fn().mockReturnValue({ status: 0 });
    statSyncMock = vi.fn().mockReturnValue({ size: 123 });
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    statSyncMock.mockReset();
    statSyncMock.mockReturnValue({ size: 123 });
  });

  it('verifies the backup first, restores with libpq env, then verifies the live database', async () => {
    const { main } = await import('../../scripts/db-restore.js');
    const code = main({
      argv: ['backup.pgdump'],
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://tamtam:p%40ss@localhost:5432/tamtam?sslmode=require',
      },
      existsSync: existsSyncMock,
      spawnSync: spawnSyncMock,
      statSync: statSyncMock,
    });

    const backupPath = resolve('backup.pgdump');
    expect(code).toBe(0);
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [process.execPath, [expect.stringContaining('db-verify.js'), '--backup', backupPath]],
      ['pnpm', ['stop']],
      ['pg_restore', [
        '--clean',
        '--if-exists',
        '--no-owner',
        '--exit-on-error',
        '--dbname=tamtam',
        '--host=localhost',
        '--port=5432',
        '--username=tamtam',
        backupPath,
      ]],
      [process.execPath, [expect.stringContaining('db-verify.js')]],
      ['pnpm', ['start']],
    ]);
    expect(spawnSyncMock.mock.calls[2][2].env).toMatchObject({
      PGPASSWORD: 'p@ss',
      PGSSLMODE: 'require',
    });
    expect(JSON.stringify(spawnSyncMock.mock.calls[2][1])).not.toContain('p@ss');
  });
});
