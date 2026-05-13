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

function getTableColumns(sqlite: Database.Database, table: string) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
}

function getMigrationRows(sqlite: Database.Database, limit?: number) {
  const limitClause = typeof limit === 'number' ? `LIMIT ${limit}` : '';
  return sqlite.prepare(`
    SELECT hash, created_at
    FROM __drizzle_migrations
    ORDER BY created_at ASC
    ${limitClause}
  `).all() as Array<{ hash: string; created_at: number }>;
}

function seedMigrationRows(sqlite: Database.Database, rows: Array<{ hash: string; created_at: number }>) {
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
  for (const row of rows) {
    insertMigration.run(row.hash, row.created_at);
  }
}

function getColumnNames(sqlite: Database.Database, table: string) {
  return getTableColumns(sqlite, table).map((column) => column.name);
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

  it('keeps a runtime-bootstrapped schema without a migration ledger compatible with the standalone migration wrapper', async () => {
    const dbPath = createDbWithSettings([]);
    process.env.TAMTAM_DB_PATH = dbPath;

    await import('@/lib/db');

    const { migrateDb } = await import('../../scripts/db-migrate.js') as {
      migrateDb: (options: { dbPath: string; migrationsFolder: string }) => void;
    };

    expect(() => migrateDb({
      dbPath,
      migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations'),
    })).not.toThrow();

    const sqlite = new Database(dbPath, { readonly: true });
    try {
      const migrationRows = sqlite.prepare(`
        SELECT hash, created_at
        FROM __drizzle_migrations
        ORDER BY created_at ASC
      `).all() as Array<{ hash: string; created_at: number }>;
      const retrievalChunks = sqlite.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'retrieval_chunks'
      `).get() as { name: string } | undefined;
      const ollamaUsage = sqlite.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'ollama_usage'
      `).get() as { name: string } | undefined;

      expect(migrationRows).toHaveLength(24);
      expect(retrievalChunks?.name).toBe('retrieval_chunks');
      expect(ollamaUsage?.name).toBe('ollama_usage');
    } finally {
      sqlite.close();
    }
  });

  it('keeps a partially recorded runtime-bootstrapped schema compatible with the standalone migration wrapper', async () => {
    const dbPath = createDbWithSettings([]);
    process.env.TAMTAM_DB_PATH = dbPath;

    await import('@/lib/db');

    const migratedDir = mkdtempSync(join(tmpdir(), 'tamtam-db-bootstrap-migrate-'));
    const migratedDbPath = join(migratedDir, 'baseline.db');
    const { migrateDb } = await import('../../scripts/db-migrate.js') as {
      migrateDb: (options: { dbPath: string; migrationsFolder: string }) => void;
    };
      migrateDb({ dbPath: migratedDbPath, migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations') });
    const migratedSqlite = new Database(migratedDbPath);
    try {
      const previousMigrationRows = getMigrationRows(migratedSqlite, 19);
      migratedSqlite.close();

      const sqlite = new Database(dbPath);
      try {
        seedMigrationRows(sqlite, previousMigrationRows);
      } finally {
        sqlite.close();
      }

      expect(() => migrateDb({
        dbPath,
        migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations'),
      })).not.toThrow();

      const migratedRuntimeSqlite = new Database(dbPath);
      try {
        const maintenanceStatus = migratedRuntimeSqlite.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'maintenance_status'
        `).get() as { name: string } | undefined;
        const jobsColumns = migratedRuntimeSqlite.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>;

        expect(maintenanceStatus?.name).toBe('maintenance_status');
        expect(jobsColumns.map((column) => column.name)).toContain('release_deadline_at');
      } finally {
        migratedRuntimeSqlite.close();
      }
    } finally {
      try {
        migratedSqlite.close();
      } catch {}
    }
  });

  it('keeps a runtime-bootstrapped schema with a ledger that predates recommendations compatible with the standalone migration wrapper', async () => {
    const dbPath = createDbWithSettings([]);
    process.env.TAMTAM_DB_PATH = dbPath;

    await import('@/lib/db');

    const migratedDir = mkdtempSync(join(tmpdir(), 'tamtam-db-bootstrap-migrate-'));
    const migratedDbPath = join(migratedDir, 'baseline.db');
    const { migrateDb } = await import('../../scripts/db-migrate.js') as {
      migrateDb: (options: { dbPath: string; migrationsFolder: string }) => void;
    };
    migrateDb({ dbPath: migratedDbPath, migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations') });

    const migratedSqlite = new Database(migratedDbPath);
    try {
      const previousMigrationRows = getMigrationRows(migratedSqlite, 6);
      migratedSqlite.close();

      const sqlite = new Database(dbPath);
      try {
        seedMigrationRows(sqlite, previousMigrationRows);
      } finally {
        sqlite.close();
      }

      expect(() => migrateDb({
        dbPath,
        migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations'),
      })).not.toThrow();

      const directDir = mkdtempSync(join(tmpdir(), 'tamtam-db-bootstrap-direct-pre-recommendations-'));
      const directDbPath = join(directDir, 'tamtam.db');
      const directSqlite = new Database(directDbPath);
      try {
        migrate(drizzle(directSqlite), { migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations') });

        const migratedRuntimeSqlite = new Database(dbPath, { readonly: true });
        try {
          expect(getColumnNames(migratedRuntimeSqlite, 'jobs').sort()).toEqual(
            getColumnNames(directSqlite, 'jobs').sort()
          );
          expect(getMigrationRows(migratedRuntimeSqlite)).toHaveLength(24);
        } finally {
          migratedRuntimeSqlite.close();
        }
      } finally {
        directSqlite.close();
      }
    } finally {
      try {
        migratedSqlite.close();
      } catch {}
    }
  });

  it('keeps a runtime-bootstrapped schema with a ledger that predates prerequisite_command and qa_url compatible with the standalone migration wrapper', async () => {
    const dbPath = createDbWithSettings([]);
    process.env.TAMTAM_DB_PATH = dbPath;

    await import('@/lib/db');

    const migratedDir = mkdtempSync(join(tmpdir(), 'tamtam-db-bootstrap-migrate-'));
    const migratedDbPath = join(migratedDir, 'baseline.db');
    const { migrateDb } = await import('../../scripts/db-migrate.js') as {
      migrateDb: (options: { dbPath: string; migrationsFolder: string }) => void;
    };
    migrateDb({ dbPath: migratedDbPath, migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations') });

    const migratedSqlite = new Database(migratedDbPath);
    try {
      const previousMigrationRows = getMigrationRows(migratedSqlite, 11);
      migratedSqlite.close();

      const sqlite = new Database(dbPath);
      try {
        seedMigrationRows(sqlite, previousMigrationRows);
      } finally {
        sqlite.close();
      }

      expect(() => migrateDb({
        dbPath,
        migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations'),
      })).not.toThrow();

      const directDir = mkdtempSync(join(tmpdir(), 'tamtam-db-bootstrap-direct-pre-prereq-'));
      const directDbPath = join(directDir, 'tamtam.db');
      const directSqlite = new Database(directDbPath);
      try {
        migrate(drizzle(directSqlite), { migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations') });

        const migratedRuntimeSqlite = new Database(dbPath, { readonly: true });
        try {
          expect(getColumnNames(migratedRuntimeSqlite, 'projects').sort()).toEqual(
            getColumnNames(directSqlite, 'projects').sort()
          );
          expect(getColumnNames(migratedRuntimeSqlite, 'agents').sort()).toEqual(
            getColumnNames(directSqlite, 'agents').sort()
          );
          expect(getMigrationRows(migratedRuntimeSqlite)).toHaveLength(24);
        } finally {
          migratedRuntimeSqlite.close();
        }
      } finally {
        directSqlite.close();
      }
    } finally {
      try {
        migratedSqlite.close();
      } catch {}
    }
  });

  it('rebuilds legacy runtime-bootstrapped projects tables before seeding a migration baseline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-db-bootstrap-legacy-projects-'));
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
        test_command TEXT,
        tests_disabled INTEGER DEFAULT 0,
        review_disabled INTEGER DEFAULT 0,
        test_cron_enabled INTEGER DEFAULT 0,
        test_cron_schedule TEXT,
        auto_commit_enabled INTEGER DEFAULT 0,
        auto_push_enabled INTEGER DEFAULT 0,
        auto_pr_merge_enabled INTEGER DEFAULT 0,
        release_after_run INTEGER DEFAULT 0,
        pr_workflow_enabled INTEGER DEFAULT 0,
        issue_auto_branch INTEGER DEFAULT 1,
        last_push_error TEXT,
        last_push_at REAL
      );
    `);
    sqlite.close();
    process.env.TAMTAM_DB_PATH = dbPath;

    await import('@/lib/db');

    const { migrateDb } = await import('../../scripts/db-migrate.js') as {
      migrateDb: (options: { dbPath: string; migrationsFolder: string }) => void;
    };

    expect(() => migrateDb({
      dbPath,
      migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations'),
    })).not.toThrow();

    const directDir = mkdtempSync(join(tmpdir(), 'tamtam-db-bootstrap-direct-projects-'));
    const directDbPath = join(directDir, 'tamtam.db');
      const directSqlite = new Database(directDbPath);
      try {
        migrate(drizzle(directSqlite), { migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations') });
        const expectedProjectsColumns = getColumnNames(directSqlite, 'projects').sort();

        const migratedSqlite = new Database(dbPath, { readonly: true });
        try {
          const projectsColumns = getColumnNames(migratedSqlite, 'projects').sort();
          const migrationRows = migratedSqlite.prepare(`
            SELECT hash, created_at
            FROM __drizzle_migrations
            ORDER BY created_at ASC
          `).all() as Array<{ hash: string; created_at: number }>;

          expect(projectsColumns).toEqual(expectedProjectsColumns);
          expect(projectsColumns).not.toContain('pr_workflow_enabled');
          expect(migrationRows).toHaveLength(24);
        } finally {
          migratedSqlite.close();
        }
      } finally {
        directSqlite.close();
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
    const columns = getTableColumns(migrated, 'agents');
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
    const columns = getTableColumns(migrated, 'projects');
    migrated.close();

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['website', 'qa_url']));
  });
});
