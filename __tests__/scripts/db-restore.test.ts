import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function createDb(dbPath: string, marker: string) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('marker', marker);
  db.close();
}

function createWalBackedDb(dbPath: string, marker: string): () => void {
  const writer = new Database(dbPath);
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Keep a second connection open so SQLite does not checkpoint the WAL away
  // when the writer closes; the restore fixture must rely on sidecars.
  const reader = new Database(dbPath, { readonly: true });
  reader.prepare('SELECT count(*) AS c FROM sqlite_master').get();

  writer.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('marker', marker);
  writer.close();

  return () => {
    reader.close();
  };
}

function readMarker(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('marker') as { value: string } | undefined;
  db.close();
  return row?.value ?? null;
}

function readMigratedMarker(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'restored_meta'").get() as { name: string } | undefined;
  if (!table) {
    db.close();
    return null;
  }
  const row = db.prepare('SELECT value FROM restored_meta WHERE key = ?').get('migrated') as { value: string } | undefined;
  db.close();
  return row?.value ?? null;
}

function writeFakePnpm(binPath: string) {
  const betterSqlitePath = JSON.stringify(require.resolve('better-sqlite3'));
  writeFileSync(binPath, `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('fs');
const Database = require(${betterSqlitePath});
const args = process.argv.slice(2);
appendFileSync(process.env.PNPM_LOG_PATH, args.join(' ') + '\\n');
if (args[0] === 'db:migrate' && process.env.TAMTAM_DB_PATH) {
  const db = new Database(process.env.TAMTAM_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS restored_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT OR REPLACE INTO restored_meta (key, value) VALUES (?, ?)').run('migrated', 'yes');
  db.close();
}
if (args[0] === 'start' && process.env.PNPM_FAIL_FIRST_START === '1') {
  const countPath = process.env.PNPM_START_COUNT_PATH;
  const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;
  const next = count + 1;
  writeFileSync(countPath, String(next));
  if (next === 1) process.exit(1);
}
if (args[0] === 'stop' && process.env.PNPM_FAIL_STOP === '1') {
  process.exit(1);
}
process.exit(0);
`);
  chmodSync(binPath, 0o755);
}

function runRestore(backupPath: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['scripts/db-restore.js', backupPath], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function withRestoreFixture(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tamtam-db-restore-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let suiteBinDir = '';

function createFixtureLayout(dir: string) {
  const dataDir = join(dir, 'data');
  const backupsDir = join(dir, 'backups');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(backupsDir, { recursive: true });
  const pnpmLogPath = join(dir, 'pnpm.log');
  writeFileSync(pnpmLogPath, '');

  return {
    dbPath: join(dataDir, 'tamtam.db'),
    backupPath: join(backupsDir, 'tamtam-backup.db'),
    pnpmLogPath,
    startCountPath: join(dir, 'start-count.txt'),
  };
}

function buildRestoreEnv(
  layout: ReturnType<typeof createFixtureLayout>,
  extra: Partial<NodeJS.ProcessEnv> = {}
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TAMTAM_DB_PATH: layout.dbPath,
    PNPM_LOG_PATH: layout.pnpmLogPath,
    PNPM_START_COUNT_PATH: layout.startCountPath,
    PATH: `${suiteBinDir}${delimiter}${process.env.PATH ?? ''}`,
    ...extra,
  };
}

describe('scripts/db-restore.js', () => {
  beforeAll(() => {
    suiteBinDir = mkdtempSync(join(tmpdir(), 'tamtam-db-restore-bin-'));
    writeFakePnpm(join(suiteBinDir, 'pnpm'));
  });

  afterAll(() => {
    if (suiteBinDir) {
      rmSync(suiteBinDir, { recursive: true, force: true });
    }
  });

  it.concurrent('restores the backup via a staged swap on success', () => withRestoreFixture(async (dir) => {
      const layout = createFixtureLayout(dir);
      createDb(layout.dbPath, 'old');
      createDb(layout.backupPath, 'new');

      const result = await runRestore(layout.backupPath, buildRestoreEnv(layout));

      expect(result.status).toBe(0);
      expect(readMarker(layout.dbPath)).toBe('new');
      expect(readMigratedMarker(layout.dbPath)).toBe('yes');
      expect(readFileSync(layout.pnpmLogPath, 'utf-8').trim().split('\n')).toEqual([
        'db:migrate',
        'stop',
        'start',
      ]);
    }));

  it.concurrent('rolls back the old database and restarts TamTam if the post-swap start fails', () => withRestoreFixture(async (dir) => {
      const layout = createFixtureLayout(dir);
      createDb(layout.dbPath, 'old');
      createDb(layout.backupPath, 'new');

      const result = await runRestore(
        layout.backupPath,
        buildRestoreEnv(layout, { PNPM_FAIL_FIRST_START: '1' })
      );

      expect(result.status).toBe(1);
      expect(readMarker(layout.dbPath)).toBe('old');
      expect(readMigratedMarker(layout.dbPath)).toBe(null);
      expect(readFileSync(layout.pnpmLogPath, 'utf-8').trim().split('\n')).toEqual([
        'db:migrate',
        'stop',
        'start',
        'start',
      ]);
      expect(result.stderr).toContain('Database restore failed');
    }));

  it.concurrent('aborts before swapping the live database when pnpm stop fails', () => withRestoreFixture(async (dir) => {
      const layout = createFixtureLayout(dir);
      createDb(layout.dbPath, 'old');
      createDb(layout.backupPath, 'new');

      const result = await runRestore(
        layout.backupPath,
        buildRestoreEnv(layout, { PNPM_FAIL_STOP: '1' })
      );

      expect(result.status).toBe(1);
      expect(readMarker(layout.dbPath)).toBe('old');
      expect(readMigratedMarker(layout.dbPath)).toBe(null);
      expect(readFileSync(layout.pnpmLogPath, 'utf-8').trim().split('\n')).toEqual([
        'db:migrate',
        'stop',
      ]);
      expect(result.stderr).toContain('aborting restore before swapping the live database');
    }));

  it.concurrent('restores backup data that lives in the backup WAL sidecar', () => withRestoreFixture(async (dir) => {
      const layout = createFixtureLayout(dir);
      createDb(layout.dbPath, 'old');
      const releaseWalFixture = createWalBackedDb(layout.backupPath, 'new-from-wal');

      try {
        expect(existsSync(`${layout.backupPath}-wal`)).toBe(true);

        const result = await runRestore(layout.backupPath, buildRestoreEnv(layout));

        expect(result.status).toBe(0);
        expect(readMarker(layout.dbPath)).toBe('new-from-wal');
        expect(readMigratedMarker(layout.dbPath)).toBe('yes');
      } finally {
        releaseWalFixture();
      }
    }));
});
