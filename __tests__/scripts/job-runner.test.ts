import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Client } from 'pg';

const RUNNER = resolve(__dirname, '..', '..', 'scripts', 'job-runner.js');

// Real-Postgres connection used by the spawned job-runner subprocess for the
// pause check. PGlite is in-process and has no socket, so the subprocess
// can't connect to it; the runner reads DATABASE_URL via `pg.Client`. The
// admin URL (used to CREATE/DROP throwaway DBs) defaults to the local
// Postgres on 5432.
const ADMIN_DB_URL = process.env.TEST_PG_ADMIN_URL || 'postgres://localhost:5432/postgres';

function runnerEnv(env: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  // Strip any inherited DATABASE_URL so each test fully controls whether the
  // subprocess can reach a pause-check DB. Tests opt-in by passing their own
  // DATABASE_URL value.
  delete inherited.DATABASE_URL;
  delete inherited.TAMTAM_DB_PATH;
  return { ...inherited, ...env };
}

function runRunner(args: string[], env: Record<string, string | undefined> = {}): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; child: ReturnType<typeof spawn> }> {
  return new Promise((res) => {
    const child = spawn('node', [RUNNER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: runnerEnv(env),
    });
    child.on('exit', (code, signal) => res({ exitCode: code, signal, child }));
  });
}

// Track all throwaway databases so afterAll can drop them once. Per-test
// teardown of these DBs is unnecessary — the names are unique per test
// (pid+timestamp+random) and only a handful are created per run.
const provisionedDbs: string[] = [];

async function createPauseDb(jobsPaused: boolean): Promise<string> {
  const dbName = `tamtam_jobrunner_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  provisionedDbs.push(dbName);

  const target = new Client({ connectionString: dbUrlFor(dbName) });
  await target.connect();
  try {
    await target.query('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await target.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2)',
      ['jobs_paused', jobsPaused ? 'true' : 'false'],
    );
  } finally {
    await target.end();
  }
  return dbUrlFor(dbName);
}

function dbUrlFor(dbName: string): string {
  // Reuse the admin connection target host/port/user but swap the database
  // segment. Simple string surgery: replace the trailing `/<db>` with
  // `/<dbName>`.
  return ADMIN_DB_URL.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);
}

async function dropProvisionedDbs(): Promise<void> {
  if (provisionedDbs.length === 0) return;
  const admin = new Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  try {
    for (const dbName of provisionedDbs.splice(0, provisionedDbs.length)) {
      try {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } catch {
        // Best-effort; leftover throwaway DBs are harmless.
      }
    }
  } finally {
    await admin.end();
  }
}

// All tmpdirs created by tests; cleaned up once after the suite. Each test
// creates its own dir (unique mkdtemp suffix) so concurrency is safe.
const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'job-runner-test-'));
  tempDirs.push(d);
  return d;
}

// Shared pause-check DBs created once for all tests. Provisioning a fresh
// Postgres DB takes ~80-180ms; reusing two (one paused, one not) across the
// three pause-related tests cuts the suite-level DB cost from ~540ms to ~180ms.
let pausedDbUrl = '';
let unpausedDbUrl = '';

beforeAll(async () => {
  [pausedDbUrl, unpausedDbUrl] = await Promise.all([
    createPauseDb(true),
    createPauseDb(false),
  ]);
});

afterAll(async () => {
  for (const d of tempDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  await dropProvisionedDbs();
});

describe.concurrent('scripts/job-runner.js', () => {
  it('logs launch + exit breadcrumbs and propagates the child exit code', async () => {
    const dir = makeTempDir();
    const logPath = join(dir, 'a.log');
    const promptPath = join(dir, 'a.prompt');
    writeFileSync(promptPath, 'hello');

    const { exitCode } = await runRunner([
      'job-a', logPath, promptPath,
      'bash', '-c', 'cat; echo done; exit 7',
    ]);

    expect(exitCode).toBe(7);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('[tamtam] launching:');
    expect(log).toContain('hello');   // prompt was piped to stdin → echoed by `cat`
    expect(log).toContain('done');    // child stdout
    expect(log).toContain('[tamtam] exited with code 7');
  });

  it('refuses to spawn the child command when jobs are paused', async () => {
    const dir = makeTempDir();
    const logPath = join(dir, 'paused.log');
    const promptPath = join(dir, 'paused.prompt');
    const markerPath = join(dir, 'child-ran');
    writeFileSync(promptPath, 'hello');

    const { exitCode } = await runRunner([
      'job-paused', logPath, promptPath,
      'bash', '-c', `touch "${markerPath}"`,
    ], { DATABASE_URL: pausedDbUrl });

    expect(exitCode).toBe(75);
    expect(existsSync(markerPath)).toBe(false);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('jobs are paused globally');
    expect(log).not.toContain('[tamtam] launching:');
  });

  it('spawns the child command when jobs are not paused', async () => {
    const dir = makeTempDir();
    const logPath = join(dir, 'unpaused.log');
    const promptPath = join(dir, 'unpaused.prompt');
    writeFileSync(promptPath, 'hello');

    const { exitCode } = await runRunner([
      'job-unpaused', logPath, promptPath,
      'bash', '-c', 'cat; echo done',
    ], { DATABASE_URL: unpausedDbUrl });

    expect(exitCode).toBe(0);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('[tamtam] launching:');
    expect(log).toContain('hello');
    expect(log).toContain('done');
  });

  it('redacts child output before writing the job log', async () => {
    const dir = makeTempDir();
    const logPath = join(dir, 'redacted.log');
    const promptPath = join(dir, 'redacted.prompt');
    writeFileSync(promptPath, '');

    const { exitCode } = await runRunner([
      'job-redacted', logPath, promptPath,
      'bash', '-c', 'echo "token=ghp_abcdefghijklmnopqrstuvwxyz123456"; echo "ordinary line"',
    ]);

    expect(exitCode).toBe(0);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('token=[REDACTED]');
    expect(log).toContain('ordinary line');
    expect(log).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
  });

  it('uses DATABASE_URL for the pause check when provided', async () => {
    const dir = makeTempDir();
    // The shared paused DB exists but the subprocess is pointed at the
    // unpaused DB. Confirms the runner honors the DATABASE_URL env it
    // receives rather than some out-of-band default.
    void pausedDbUrl; // provisioned in beforeAll but not used by this subprocess
    const logPath = join(dir, 'custom-db.log');
    const promptPath = join(dir, 'custom-db.prompt');
    writeFileSync(promptPath, 'hello');

    const { exitCode } = await runRunner([
      'job-custom-db', logPath, promptPath,
      'bash', '-c', 'cat; echo done',
    ], { DATABASE_URL: unpausedDbUrl });

    expect(exitCode).toBe(0);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('[tamtam] launching:');
    expect(log).toContain('done');
  });

  it('exits 127 when the command binary does not exist', async () => {
    const dir = makeTempDir();
    const logPath = join(dir, 'b.log');
    const promptPath = join(dir, 'b.prompt');
    writeFileSync(promptPath, '');

    const { exitCode } = await runRunner([
      'job-b', logPath, promptPath,
      '/no/such/binary-' + Date.now(),
    ]);

    expect(exitCode).toBe(127);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toMatch(/\[tamtam\] (spawn (failed|error)):/);
  });

  it('forwards SIGTERM to the child so it actually dies (orphan fix)', async () => {
    const dir = makeTempDir();
    const logPath = join(dir, 'c.log');
    const promptPath = join(dir, 'c.prompt');
    writeFileSync(promptPath, '');

    // Child catches SIGTERM, exits 143 (the convention: 128 + signal#).
    const childCode = `
      process.on('SIGTERM', () => process.exit(143));
      console.log('ready');
      setInterval(() => {}, 1000);
    `;

    const child = spawn('node', [RUNNER,
      'job-c', logPath, promptPath,
      'node', '-e', childCode,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: runnerEnv(),
    });

    // Wait until the inner child has installed its handler. Tight 10ms
    // polling cuts the typical wait from ~50ms to a few ms.
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => { clearInterval(poll); rej(new Error('child never said ready')); }, 5000);
      const poll = setInterval(() => {
        let log = '';
        try { log = readFileSync(logPath, 'utf-8'); } catch { return; }
        if (log.includes('ready')) { clearTimeout(t); clearInterval(poll); res(); }
      }, 10);
    });

    const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));
    child.kill('SIGTERM');
    const code = await exited;

    // The runner forwarded SIGTERM, the child exited 143, the runner
    // propagates that exit code. If signal-forwarding were broken, the inner
    // node child would survive past the runner's exit (the orphan we're
    // fixing) and the test would either hang or report a different code.
    expect(code).toBe(143);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('[tamtam] exited with code 143');
  });

  it('refuses to start with too few args', async () => {
    const { exitCode } = await runRunner(['only-jobid']);
    expect(exitCode).toBe(2);
  });
});
