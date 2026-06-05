import { describe, expect, it } from 'vitest';

// Regression guard: a Postgres restart once wedged the whole server because the
// pool had no timeouts — queries waited forever on dead sockets. These options
// make the pool fail fast and self-heal. See lib/db/index.ts.
describe('db pool resilience config', () => {
  it('configures connection/idle/query timeouts and keepalive', async () => {
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = 'postgres://tamtam@127.0.0.1:5432/tamtam';
    }
    const { pool } = await import('@/lib/db');
    const options = pool.options as unknown as Record<string, unknown>;

    expect(options.connectionTimeoutMillis).toBe(5_000);
    expect(options.idleTimeoutMillis).toBe(30_000);
    expect(options.keepAlive).toBe(true);
    expect(options.statement_timeout).toBe(30_000);
    expect(options.query_timeout).toBe(30_000);
  });
});
