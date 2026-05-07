import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function createDbWithSettings(rows: Array<{ key: string; value: string }>) {
  const dir = mkdtempSync(join(tmpdir(), 'tamtam-db-bootstrap-'));
  const dbPath = join(dir, 'tamtam.db');
  const sqlite = new Database(dbPath);
  sqlite.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const insert = sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const row of rows) insert.run(row.key, row.value);
  sqlite.close();
  return dbPath;
}

describe('db bootstrap migrations', () => {
  afterEach(() => {
    delete process.env.TAMTAM_DB_PATH;
    vi.resetModules();
  });

  it('removes deprecated fix-ci retry settings without creating review_fix_max_iterations', async () => {
    const dbPath = createDbWithSettings([
      { key: 'fix_ci_max_retries', value: '5' },
      { key: 'fix_ci_retry_window_seconds', value: '120' },
      { key: 'fix_ci_fast_crash_ms', value: '5000' },
    ]);
    process.env.TAMTAM_DB_PATH = dbPath;

    await import('@/lib/db');
    const { getSettings } = await import('@/lib/shared/config');

    const sqlite = new Database(dbPath, { readonly: true });
    const rows = sqlite.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{ key: string; value: string }>;
    sqlite.close();

    expect(rows).toEqual([]);
    expect(getSettings().review_fix_max_iterations).toBe(3);
  });

  it('preserves an explicit review_fix_max_iterations row while still removing deprecated keys', async () => {
    const dbPath = createDbWithSettings([
      { key: 'fix_ci_max_retries', value: '1' },
      { key: 'review_fix_max_iterations', value: '6' },
    ]);
    process.env.TAMTAM_DB_PATH = dbPath;

    await import('@/lib/db');
    const { getSettings } = await import('@/lib/shared/config');

    const sqlite = new Database(dbPath, { readonly: true });
    const rows = sqlite.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{ key: string; value: string }>;
    sqlite.close();

    expect(rows).toEqual([{ key: 'review_fix_max_iterations', value: '6' }]);
    expect(getSettings().review_fix_max_iterations).toBe(6);
  });
});
