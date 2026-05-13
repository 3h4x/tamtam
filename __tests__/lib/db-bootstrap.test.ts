import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

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

  it('creates queued_agent_runs and recommendations tables during runtime bootstrap', async () => {
    const dbPath = createDbWithSettings([]);
    process.env.TAMTAM_DB_PATH = dbPath;

    await import('@/lib/db');

    const sqlite = new Database(dbPath, { readonly: true });
    const queuedAgentRuns = sqlite.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'queued_agent_runs'
    `).get() as { name: string } | undefined;
    const recommendations = sqlite.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'recommendations'
    `).get() as { name: string } | undefined;
    const queuedIndex = sqlite.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name = 'queued_agent_runs_project_agent'
    `).get() as { name: string } | undefined;
    sqlite.close();

    expect(queuedAgentRuns?.name).toBe('queued_agent_runs');
    expect(recommendations?.name).toBe('recommendations');
    expect(queuedIndex?.name).toBe('queued_agent_runs_project_agent');
  });

  it('keeps runtime-bootstrapped schema compatible with the numbered migrations', async () => {
    const dbPath = createDbWithSettings([]);
    process.env.TAMTAM_DB_PATH = dbPath;

    await import('@/lib/db');

    const migratedDir = mkdtempSync(join(tmpdir(), 'tamtam-db-bootstrap-migrate-'));
    const migratedDbPath = join(migratedDir, 'baseline.db');
    const migratedSqlite = new Database(migratedDbPath);
    try {
      migrate(drizzle(migratedSqlite), { migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations') });
      const previousMigrationRows = migratedSqlite.prepare(`
        SELECT hash, created_at
        FROM __drizzle_migrations
        ORDER BY created_at ASC
        LIMIT 19
      `).all() as Array<{ hash: string; created_at: number }>;
      migratedSqlite.close();

      const sqlite = new Database(dbPath);
      try {
        sqlite.exec(`
          CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
            id SERIAL PRIMARY KEY,
            hash text NOT NULL,
            created_at numeric
          )
        `);
        const insertMigration = sqlite.prepare(`
          INSERT INTO "__drizzle_migrations" (hash, created_at)
          VALUES (?, ?)
        `);
        for (const row of previousMigrationRows) {
          insertMigration.run(row.hash, row.created_at);
        }

        expect(() =>
          migrate(drizzle(sqlite), { migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations') })
        ).not.toThrow();

        const maintenanceStatus = sqlite.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'maintenance_status'
        `).get() as { name: string } | undefined;
        const jobsColumns = sqlite.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>;

        expect(maintenanceStatus?.name).toBe('maintenance_status');
        expect(jobsColumns.map((column) => column.name)).toContain('release_deadline_at');
      } finally {
        sqlite.close();
      }
    } finally {
      try {
        migratedSqlite.close();
      } catch {}
    }
  });

  it('backfills doc_paths and provider columns onto legacy agents tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-db-bootstrap-'));
    const dbPath = join(dir, 'tamtam.db');
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project TEXT NOT NULL,
        skill_ids TEXT NOT NULL DEFAULT '[]',
        model TEXT NOT NULL DEFAULT 'normal',
        prompt TEXT NOT NULL DEFAULT '',
        schedule TEXT,
        runner TEXT NOT NULL DEFAULT 'pm2',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `);
    sqlite.close();
    process.env.TAMTAM_DB_PATH = dbPath;

    await import('@/lib/db');

    const migrated = new Database(dbPath, { readonly: true });
    const columns = migrated.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>;
    migrated.close();

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['doc_paths', 'provider']));
  });

  it('backfills qa_url onto legacy projects tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-db-bootstrap-'));
    const dbPath = join(dir, 'tamtam.db');
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE projects (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        enabled INTEGER DEFAULT 0,
        github TEXT,
        priority TEXT,
        custom_actions TEXT,
        website TEXT
      );
    `);
    sqlite.close();
    process.env.TAMTAM_DB_PATH = dbPath;

    await import('@/lib/db');

    const migrated = new Database(dbPath, { readonly: true });
    const columns = migrated.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    migrated.close();

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['website', 'qa_url']));
  });
});
