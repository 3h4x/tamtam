#!/usr/bin/env node
// Verify either the live Postgres database (`pnpm db:verify`) or, with
// `--backup <file>`, a custom-format dump produced by `pg_dump --format=custom`.

const { spawnSync } = require('child_process');
const { statSync } = require('fs');
const { Client } = require('pg');

async function main(deps = {}) {
  const argv = deps.argv ?? process.argv.slice(2);
  const env = deps.env ?? process.env;
  const PgClient = deps.Client ?? Client;
  const spawn = deps.spawnSync ?? spawnSync;
  const stat = deps.statSync ?? statSync;

  if (argv[0] === '--backup') {
    return verifyBackup(argv[1], { spawn, stat });
  }
  if (argv.length === 0) {
    return verifyLiveDatabase(env.DATABASE_URL, PgClient);
  }
  if (argv.length === 1 && !argv[0].startsWith('-')) {
    return verifyLiveDatabase(argv[0], PgClient);
  }

  console.error('Usage: node scripts/db-verify.js [DATABASE_URL]');
  console.error('       node scripts/db-verify.js --backup <path-to-backup.pgdump>');
  return 1;
}

async function verifyLiveDatabase(dbUrl, PgClient = Client) {
  if (!dbUrl) {
    console.error('DATABASE_URL is required to verify the live database.');
    return 1;
  }
  const client = new PgClient({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const ext = await client.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    if (ext.rows.length === 0) {
      throw new Error('pgvector extension missing');
    }
    const tables = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    console.log(`Database verified: ${redactDbUrl(dbUrl)} (tables=${tables.rows[0].n})`);
    return 0;
  } catch (error) {
    console.error(`Database verification failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

function verifyBackup(dumpPath, deps = {}) {
  const spawn = deps.spawn ?? spawnSync;
  const stat = deps.stat ?? statSync;
  if (!dumpPath) {
    console.error('Usage: node scripts/db-verify.js --backup <path-to-backup.pgdump>');
    return 1;
  }
  let size;
  try {
    size = stat(dumpPath).size;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      console.error(`Backup file not found: ${dumpPath}`);
    } else {
      console.error(`Backup file cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
  if (size === 0) {
    console.error(`Backup file is empty: ${dumpPath}`);
    return 1;
  }

  const result = spawn('pg_restore', ['--list', dumpPath], { encoding: 'utf8' });
  if (result.error) {
    console.error('Failed to spawn pg_restore:', result.error.message);
    return 1;
  }
  if (result.status !== 0) {
    console.error(`pg_restore --list failed (exit ${result.status}):`);
    console.error(result.stderr);
    return 1;
  }
  const tocEntries = result.stdout.split('\n').filter((line) => /^\d/.test(line)).length;
  console.log(`Backup verified: ${dumpPath} (${tocEntries} TOC entries, ${size} bytes)`);
  return 0;
}

function redactDbUrl(dbUrl) {
  try {
    const url = new URL(dbUrl);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<database-url>';
  }
}

if (require.main === module) {
  void main().then((code) => {
    if (code !== 0) process.exit(code);
  });
}

module.exports = {
  main,
  verifyBackup,
  verifyLiveDatabase,
};
