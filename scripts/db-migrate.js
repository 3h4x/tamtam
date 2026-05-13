#!/usr/bin/env node

const Database = require('better-sqlite3');
const crypto = require('crypto');
const { mkdirSync, readFileSync } = require('fs');
const { dirname, join } = require('path');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { migrate } = require('drizzle-orm/better-sqlite3/migrator');

const DEFAULT_DB_PATH = join(process.cwd(), 'data', 'db', 'tamtam.db');
const DEFAULT_MIGRATIONS_FOLDER = join(process.cwd(), 'lib', 'db', 'migrations');

// Older upgraded databases may already have these columns because the app
// bootstrap added them before the numbered migrations were made authoritative.
// The standalone wrapper skips only those specific ALTERs when the column
// already exists; fresh databases still get the real numbered migration SQL.
const RUNTIME_BOOTSTRAP_COLUMN_UPDATES = [
  "ALTER TABLE projects ADD COLUMN paused INTEGER NOT NULL DEFAULT 0",
  'ALTER TABLE jobs ADD COLUMN release_deadline_at INTEGER',
];
const RUNTIME_COMPATIBLE_MIGRATIONS = new Map([
  ['0001_rare_wong', { type: 'column', table: 'jobs', column: 'aborted_at' }],
  ['0002_dusty_typhoid_mary', { type: 'column', table: 'agents', column: 'doc_paths' }],
  ['0006_cooing_ink', {
    type: 'all',
    checks: [
      { type: 'table', table: 'recommendations' },
      { type: 'column', table: 'jobs', column: 'work_summary' },
      { type: 'column', table: 'jobs', column: 'modified_files' },
    ],
  }],
  ['0008_windy_whistler', {
    type: 'all',
    checks: [
      { type: 'column', table: 'agents', column: 'provider' },
      { type: 'column', table: 'jobs', column: 'provider' },
    ],
  }],
  ['0009_burly_alice', { type: 'table', table: 'queued_agent_runs' }],
  ['0010_past_steel_serpent', {
    type: 'all',
    checks: [
      { type: 'column', table: 'projects', column: 'review_prompt_addendum' },
      { type: 'column', table: 'projects', column: 'fix_prompt_addendum' },
    ],
  }],
  ['0011_natural_nebula', { type: 'column', table: 'agents', column: 'prerequisite_command' }],
  ['0012_first_chronomancer', { type: 'missingColumn', table: 'projects', column: 'pr_workflow_enabled' }],
  ['0015_parched_butterfly', { type: 'column', table: 'projects', column: 'website' }],
  ['0016_noisy_dazzler', { type: 'column', table: 'projects', column: 'qa_url' }],
  ['0017_slimy_justin_hammer', { type: 'table', table: 'notification_throttle' }],
  ['0018_green_rattler', { type: 'column', table: 'projects', column: 'archived' }],
  ['0019_graceful_wendell_rand', { type: 'table', table: 'maintenance_status' }],
  ['0020_premium_katie_power', { type: 'column', table: 'projects', column: 'paused' }],
  ['0004_fixed_titania', { type: 'column', table: 'jobs', column: 'prompt_bytes' }],
  ['0005_calm_lord_tyger', { type: 'column', table: 'jobs', column: 'verdict' }],
  ['0023_adorable_preak', { type: 'column', table: 'jobs', column: 'release_deadline_at' }],
]);
const RUNTIME_BOOTSTRAP_BASELINE_MARKERS = {
  tables: ['queued_agent_runs', 'notification_throttle', 'maintenance_status', 'recommendations'],
  columns: [
    { table: 'projects', column: 'archived' },
    { table: 'projects', column: 'qa_url' },
    { table: 'agents', column: 'prerequisite_command' },
    { table: 'jobs', column: 'work_summary' },
  ],
};
const RUNTIME_BOOTSTRAP_BASELINE_TAG = '0019_graceful_wendell_rand';
const RUNTIME_BOOTSTRAP_PAUSED_TAG = '0020_premium_katie_power';

function resolveDbPath(env = process.env) {
  return env.TAMTAM_DB_PATH || DEFAULT_DB_PATH;
}

function ensureRuntimeBootstrapColumns(sqlite) {
  for (const statement of RUNTIME_BOOTSTRAP_COLUMN_UPDATES) {
    try {
      sqlite.exec(statement);
    } catch {}
  }
}

function hasColumn(sqlite, table, column) {
  try {
    return sqlite.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function hasTable(sqlite, table) {
  try {
    return Boolean(sqlite.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(table));
  } catch {
    return false;
  }
}

function readMigrationFiles(migrationsFolder) {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'));
  return journal.entries.map((entry) => {
    const sql = readFileSync(join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
    return {
      tag: entry.tag,
      folderMillis: entry.when,
      hash: crypto.createHash('sha256').update(sql).digest('hex'),
      statements: sql.split('--> statement-breakpoint'),
    };
  });
}

function hasCompatibleMigrationState(sqlite, migration) {
  if (!migration) {
    return false;
  }
  if (migration.type === 'all') {
    return migration.checks.every((check) => hasCompatibleMigrationState(sqlite, check));
  }
  if (migration.type === 'table') {
    return hasTable(sqlite, migration.table);
  }
  if (migration.type === 'missingColumn') {
    return !hasColumn(sqlite, migration.table, migration.column);
  }
  if (migration.type === 'column') {
    return hasColumn(sqlite, migration.table, migration.column);
  }
  return false;
}

function getLastMigrationCreatedAt(sqlite) {
  if (!hasTable(sqlite, '__drizzle_migrations')) {
    return null;
  }
  const lastMigration = sqlite.prepare(`
    SELECT created_at
    FROM "__drizzle_migrations"
    ORDER BY created_at DESC
    LIMIT 1
  `).get();
  return lastMigration ? Number(lastMigration.created_at) : null;
}

function looksLikeRuntimeBootstrapSchema(sqlite) {
  return (
    RUNTIME_BOOTSTRAP_BASELINE_MARKERS.tables.every((table) => hasTable(sqlite, table))
    && RUNTIME_BOOTSTRAP_BASELINE_MARKERS.columns.every(({ table, column }) => hasColumn(sqlite, table, column))
  );
}

function normalizeLegacyRuntimeBootstrapSchema(sqlite) {
  if (!looksLikeRuntimeBootstrapSchema(sqlite) || !hasColumn(sqlite, 'projects', 'pr_workflow_enabled')) {
    return false;
  }
  sqlite.exec('ALTER TABLE projects DROP COLUMN pr_workflow_enabled');
  return true;
}

function getRuntimeBootstrapBaselineTag(sqlite) {
  if (hasColumn(sqlite, 'projects', 'paused')) {
    return RUNTIME_BOOTSTRAP_PAUSED_TAG;
  }
  return RUNTIME_BOOTSTRAP_BASELINE_TAG;
}

function syncRuntimeBootstrapMigrationBaseline(sqlite, migrationsFolder) {
  const hasCompatibilityColumns = (
    hasColumn(sqlite, 'projects', 'paused')
    || hasColumn(sqlite, 'jobs', 'release_deadline_at')
  );
  if (!hasCompatibilityColumns || !looksLikeRuntimeBootstrapSchema(sqlite)) {
    return false;
  }

  normalizeLegacyRuntimeBootstrapSchema(sqlite);

  const maxBaselineTag = getRuntimeBootstrapBaselineTag(sqlite);
  const migrations = readMigrationFiles(migrationsFolder);
  const maxBaselineMigration = migrations.find((migration) => migration.tag === maxBaselineTag);
  if (!maxBaselineMigration) {
    throw new Error(`Missing runtime bootstrap baseline migration: ${maxBaselineTag}`);
  }

  const lastMigrationCreatedAt = getLastMigrationCreatedAt(sqlite);
  if (lastMigrationCreatedAt !== null && lastMigrationCreatedAt >= maxBaselineMigration.folderMillis) {
    return false;
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
  const insertMigration = sqlite.prepare(`
    INSERT INTO "__drizzle_migrations" ("hash", "created_at")
    VALUES (?, ?)
  `);

  sqlite.exec('BEGIN');
  try {
    for (const migration of migrations) {
      if (lastMigrationCreatedAt !== null && lastMigrationCreatedAt >= migration.folderMillis) {
        continue;
      }
      insertMigration.run(migration.hash, migration.folderMillis);
      if (migration.tag === maxBaselineTag) {
        break;
      }
    }
    sqlite.exec('COMMIT');
    return true;
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

function migrateDbWithRuntimeColumnCompatibility(sqlite, migrationsFolder) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
  const lastCreatedAt = Number(getLastMigrationCreatedAt(sqlite) ?? 0);
  const migrations = readMigrationFiles(migrationsFolder);
  const insertMigration = sqlite.prepare(`
    INSERT INTO "__drizzle_migrations" ("hash", "created_at")
    VALUES (?, ?)
  `);

  sqlite.exec('BEGIN');
  try {
    for (const migration of migrations) {
      if (lastCreatedAt >= migration.folderMillis) continue;

      const compatibleMigration = RUNTIME_COMPATIBLE_MIGRATIONS.get(migration.tag);
      if (hasCompatibleMigrationState(sqlite, compatibleMigration)) {
        insertMigration.run(migration.hash, migration.folderMillis);
        continue;
      }

      for (const statement of migration.statements) {
        sqlite.exec(statement);
      }
      insertMigration.run(migration.hash, migration.folderMillis);
    }
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

function migrateDb(options = {}) {
  const dbPath = options.dbPath || resolveDbPath();
  const migrationsFolder = options.migrationsFolder || DEFAULT_MIGRATIONS_FOLDER;
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);
  try {
    syncRuntimeBootstrapMigrationBaseline(sqlite, migrationsFolder);
    if (
      hasColumn(sqlite, 'projects', 'paused') ||
      hasColumn(sqlite, 'jobs', 'release_deadline_at')
    ) {
      migrateDbWithRuntimeColumnCompatibility(sqlite, migrationsFolder);
    } else {
      migrate(drizzle(sqlite), { migrationsFolder });
    }
    ensureRuntimeBootstrapColumns(sqlite);
  } finally {
    sqlite.close();
  }

  return dbPath;
}

if (require.main === module) {
  try {
    const dbPath = migrateDb();
    console.log(`Database migrated: ${dbPath}`);
  } catch (error) {
    console.error(`Database migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  migrateDb,
  ensureRuntimeBootstrapColumns,
  migrateDbWithRuntimeColumnCompatibility,
  syncRuntimeBootstrapMigrationBaseline,
  resolveDbPath,
  RUNTIME_BOOTSTRAP_COLUMN_UPDATES,
};
