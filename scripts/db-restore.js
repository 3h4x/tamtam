#!/usr/bin/env node
// Restore a Postgres custom-format dump (produced by /api/settings/backup or
// `pg_dump --format=custom`) into the database referenced by DATABASE_URL.
//
// Strategy:
//   1. Verify the dump is readable (db-verify.js --backup → pg_restore --list).
//   2. Stop TamTam so no connections fight the restore.
//   3. Run `pg_restore --clean --if-exists --no-owner`.
//   4. Verify the restored live DB.
//   5. Restart TamTam.

const { spawnSync } = require('child_process');
const { statSync } = require('fs');
const { join, resolve } = require('path');

const repoRoot = resolve(__dirname, '..');

function main(deps = {}) {
  const argv = deps.argv ?? process.argv.slice(2);
  const env = deps.env ?? process.env;
  const spawn = deps.spawnSync ?? spawnSync;
  const stat = deps.statSync ?? statSync;
  const backupArg = argv[0];

  if (!backupArg) {
    console.error('Usage: pnpm db:restore <path-to-backup.pgdump>');
    return 1;
  }

  const backupPath = resolve(backupArg);
  let backupStats;
  try {
    backupStats = stat(backupPath);
  } catch {
    console.error(`Backup file missing or empty: ${backupPath}`);
    return 1;
  }
  if (backupStats.size === 0) {
    console.error(`Backup file missing or empty: ${backupPath}`);
    return 1;
  }

  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is required to restore.');
    return 1;
  }

  const verifyScriptPath = join(__dirname, 'db-verify.js');
  let stoppedForSwap = false;

  try {
    run(process.execPath, [verifyScriptPath, '--backup', backupPath], {}, { spawn, env });

    ensureStoppedBeforeSwap({ spawn, env });
    stoppedForSwap = true;

    run('pg_restore', [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--exit-on-error',
      ...pgRestoreConnectionArgs(dbUrl),
      backupPath,
    ], { env: pgEnvFromDatabaseUrl(dbUrl) }, { spawn, env });

    run(process.execPath, [verifyScriptPath], {}, { spawn, env });
    run('pnpm', ['start'], {}, { spawn, env });
    stoppedForSwap = false;

    console.log(`Database restored from ${backupPath}`);
    return 0;
  } catch (error) {
    console.error(`Database restore failed: ${error instanceof Error ? error.message : String(error)}`);
    if (stoppedForSwap) {
      const startResult = run('pnpm', ['start'], { allowFailure: true }, { spawn, env });
      if (startResult.status !== 0) {
        console.error('Failed to restart TamTam after restore failure.');
      }
    }
    return 1;
  }
}

function run(command, args, options = {}, deps = {}) {
  const spawn = deps.spawn ?? spawnSync;
  const baseEnv = deps.env ?? process.env;
  const result = spawn(command, args, {
    stdio: 'inherit',
    cwd: options.cwd ?? repoRoot,
    env: { ...baseEnv, ...(options.env ?? {}) },
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status || 1}`);
  }
  return result;
}

function ensureStoppedBeforeSwap(deps = {}) {
  const stopResult = run('pnpm', ['stop'], { allowFailure: true }, deps);
  if (stopResult.status !== 0) {
    throw new Error(`pnpm stop failed with status ${stopResult.status || 1}; aborting restore`);
  }
}

function pgRestoreConnectionArgs(dbUrl) {
  const url = new URL(dbUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const args = [];
  if (database) args.push(`--dbname=${database}`);
  if (url.hostname) args.push(`--host=${url.hostname}`);
  if (url.port) args.push(`--port=${url.port}`);
  if (url.username) args.push(`--username=${decodeURIComponent(url.username)}`);
  return args;
}

function pgEnvFromDatabaseUrl(dbUrl) {
  const url = new URL(dbUrl);
  const env = {};
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode) env.PGSSLMODE = sslMode;
  const connectTimeout = url.searchParams.get('connect_timeout');
  if (connectTimeout) env.PGCONNECT_TIMEOUT = connectTimeout;
  const applicationName = url.searchParams.get('application_name');
  if (applicationName) env.PGAPPNAME = applicationName;
  return env;
}

if (require.main === module) {
  const code = main();
  if (code !== 0) process.exit(code);
}

module.exports = {
  main,
  pgEnvFromDatabaseUrl,
  pgRestoreConnectionArgs,
};
