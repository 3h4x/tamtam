#!/usr/bin/env node

const { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } = require('fs');
const { dirname, join, resolve } = require('path');
const { spawnSync } = require('child_process');

const backupArg = process.argv[2];
if (!backupArg) {
  console.error('Usage: pnpm db:restore <path-to-backup.db>');
  process.exit(1);
}

const backupPath = resolve(backupArg);
const dbPath = process.env.TAMTAM_DB_PATH || join(process.cwd(), 'data', 'db', 'tamtam.db');

if (!existsSync(backupPath)) {
  console.error(`Backup file not found: ${backupPath}`);
  process.exit(1);
}

const dbDir = dirname(dbPath);
mkdirSync(dbDir, { recursive: true });

const restoreId = `${Date.now()}-${process.pid}`;
const stagedPath = join(dbDir, `.tamtam-restore-${restoreId}.staged.db`);
const rollbackPath = join(dbDir, `.tamtam-restore-${restoreId}.rollback.db`);
let stoppedForSwap = false;
let swappedLiveDb = false;

try {
  run(process.execPath, ['scripts/db-verify.js', backupPath]);
  copySqliteFiles(backupPath, stagedPath);
  run('pnpm', ['db:migrate'], { env: { TAMTAM_DB_PATH: stagedPath } });
  run(process.execPath, ['scripts/db-verify.js', stagedPath]);

  ensureStoppedBeforeSwap(dbPath);
  stoppedForSwap = true;

  if (existsSync(dbPath)) {
    moveSqliteFiles(dbPath, rollbackPath);
  } else {
    removeSqliteFiles(rollbackPath);
  }

  removeSqliteFiles(dbPath);
  moveSqliteFiles(stagedPath, dbPath);
  swappedLiveDb = true;

  run(process.execPath, ['scripts/db-verify.js', dbPath]);
  run('pnpm', ['start']);
  stoppedForSwap = false;

  removeSqliteFiles(rollbackPath);
  console.log(`Database restored from ${backupPath}`);
} catch (error) {
  console.error(`Database restore failed: ${error instanceof Error ? error.message : String(error)}`);

  if (swappedLiveDb) {
    removeSqliteFiles(dbPath);
  }
  if (existsSync(rollbackPath)) {
    moveSqliteFiles(rollbackPath, dbPath);
  }

  removeSqliteFiles(stagedPath);

  if (stoppedForSwap) {
    const startResult = run('pnpm', ['start'], { allowFailure: true });
    if (startResult.status !== 0) {
      console.error('Failed to restart TamTam after restore failure.');
    }
  }

  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status || 1}`);
  }
  return result;
}

function ensureStoppedBeforeSwap(dbPath) {
  const stopResult = run('pnpm', ['stop'], { allowFailure: true });
  if (stopResult.status === 0) {
    return;
  }

  if (!existsSync(dbPath)) {
    return;
  }

  throw new Error(`pnpm stop failed with status ${stopResult.status || 1}; aborting restore before swapping the live database`);
}

function sqliteSidecarPaths(basePath) {
  return [basePath, `${basePath}-wal`, `${basePath}-shm`];
}

function copySqliteFiles(fromBase, toBase) {
  const pairs = sqliteSidecarPaths(fromBase).map((fromPath, index) => [
    fromPath,
    sqliteSidecarPaths(toBase)[index],
  ]);
  for (const [fromPath, toPath] of pairs) {
    if (existsSync(fromPath)) {
      rmSync(toPath, { force: true });
      copyFileSync(fromPath, toPath);
    }
  }
}

function moveSqliteFiles(fromBase, toBase) {
  const pairs = sqliteSidecarPaths(fromBase).map((fromPath, index) => [
    fromPath,
    sqliteSidecarPaths(toBase)[index],
  ]);
  for (const [fromPath, toPath] of pairs) {
    if (existsSync(fromPath)) {
      rmSync(toPath, { force: true });
      renameSync(fromPath, toPath);
    }
  }
}

function removeSqliteFiles(basePath) {
  for (const path of sqliteSidecarPaths(basePath)) {
    rmSync(path, { force: true });
  }
}
