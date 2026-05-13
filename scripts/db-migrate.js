#!/usr/bin/env node

const Database = require('better-sqlite3');
const { mkdirSync } = require('fs');
const { dirname, join } = require('path');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { migrate } = require('drizzle-orm/better-sqlite3/migrator');

const DEFAULT_DB_PATH = join(process.cwd(), 'data', 'db', 'tamtam.db');
const DEFAULT_MIGRATIONS_FOLDER = join(process.cwd(), 'lib', 'db', 'migrations');

// These schema pieces are intentionally runtime-managed because their numbered
// migrations are no-op trackers. Keep the standalone migration workflow in
// sync so restores and operator-run `pnpm db:migrate` do not depend on a later
// app boot to materialize the advertised schema.
const NOOP_TRACKED_SCHEMA_UPDATES = [
  "ALTER TABLE projects ADD COLUMN paused INTEGER NOT NULL DEFAULT 0",
  'ALTER TABLE jobs ADD COLUMN release_deadline_at INTEGER',
];

function resolveDbPath(env = process.env) {
  return env.TAMTAM_DB_PATH || DEFAULT_DB_PATH;
}

function ensureNoopTrackedSchema(sqlite) {
  for (const statement of NOOP_TRACKED_SCHEMA_UPDATES) {
    try {
      sqlite.exec(statement);
    } catch {}
  }
}

function migrateDb(options = {}) {
  const dbPath = options.dbPath || resolveDbPath();
  const migrationsFolder = options.migrationsFolder || DEFAULT_MIGRATIONS_FOLDER;
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder });
    ensureNoopTrackedSchema(sqlite);
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
  ensureNoopTrackedSchema,
  resolveDbPath,
  NOOP_TRACKED_SCHEMA_UPDATES,
};
