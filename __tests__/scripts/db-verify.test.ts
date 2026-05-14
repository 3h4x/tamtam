import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('scripts/db-verify.js', () => {
  let clientMocks: {
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    ctor: ReturnType<typeof vi.fn>;
  };
  let existsSyncMock: ReturnType<typeof vi.fn>;
  let spawnSyncMock: ReturnType<typeof vi.fn>;
  let statSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clientMocks = {
      connect: vi.fn(),
      end: vi.fn(),
      query: vi.fn(),
      ctor: vi.fn(),
    };
    existsSyncMock = vi.fn();
    spawnSyncMock = vi.fn();
    statSyncMock = vi.fn();
    clientMocks.query
      .mockResolvedValueOnce({ rows: [{ extname: 'vector' }] })
      .mockResolvedValueOnce({ rows: [{ n: 12 }] });
    clientMocks.end.mockResolvedValue(undefined);
  });

  it('verifies the live database when called without args', async () => {
    const { main } = await import('../../scripts/db-verify.js');
    class Client {
      constructor(options: unknown) {
        const recordCtor = clientMocks.ctor as unknown as (value: unknown) => void;
        recordCtor(options);
      }
      connect = clientMocks.connect;
      query = clientMocks.query;
      end = clientMocks.end;
    }

    const code = await main({
      argv: [],
      env: { DATABASE_URL: 'postgres://tamtam:p%40ss@localhost:5432/tamtam' },
      Client,
    });

    expect(code).toBe(0);
    expect(clientMocks.ctor).toHaveBeenCalledWith({
      connectionString: 'postgres://tamtam:p%40ss@localhost:5432/tamtam',
      connectionTimeoutMillis: 5000,
    });
    expect(clientMocks.query).toHaveBeenCalledWith("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    expect(clientMocks.query).toHaveBeenCalledWith(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(clientMocks.end).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('verifies backup dumps only in explicit backup mode', async () => {
    const { main } = await import('../../scripts/db-verify.js');
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ size: 42 });
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '1; table public settings\n', stderr: '' });

    const code = await main({
      argv: ['--backup', '/tmp/backup.pgdump'],
      existsSync: existsSyncMock,
      spawnSync: spawnSyncMock,
      statSync: statSyncMock,
    });

    expect(code).toBe(0);
    expect(spawnSyncMock).toHaveBeenCalledWith('pg_restore', ['--list', '/tmp/backup.pgdump'], { encoding: 'utf8' });
    expect(clientMocks.ctor).not.toHaveBeenCalled();
  });
});
