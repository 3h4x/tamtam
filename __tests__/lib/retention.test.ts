import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { RetentionConfig } from '@/lib/jobs/retention';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      pid INTEGER NOT NULL,
      log_path TEXT,
      started_at REAL NOT NULL,
      finished_at REAL,
      exit_code INTEGER,
      seen INTEGER DEFAULT 0,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_create_tokens INTEGER,
      session_id TEXT,
      user_prompt TEXT,
      context_meta TEXT,
      parent_job_id TEXT,
      gh_issue_number INTEGER,
      gh_issue_repo TEXT,
      gh_issue_title TEXT,
      log_pruned INTEGER DEFAULT 0,
      verdict TEXT,
      cost_usd REAL,
      model TEXT,
      release_id TEXT,
      aborted_at REAL,
      release_deadline_at INTEGER,
      prompt_bytes INTEGER,
      work_summary TEXT,
      modified_files TEXT,
      provider TEXT
    );
    CREATE TABLE IF NOT EXISTS maintenance_status (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at REAL NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function makeJob(
  id: string,
  project: string,
  startedAt: number,
  finishedAt: number | null,
  logPath: string | null,
): typeof schema.jobs.$inferInsert {
  return {
    id,
    project,
    kind: 'review',
    pid: 1,
    startedAt,
    finishedAt,
    exitCode: finishedAt !== null ? 0 : null,
    logPath,
    seen: false,
    logPruned: false,
  };
}

describe('pruneProjectLogs', () => {
  let tempDir: string;
  let testDb: ReturnType<typeof createTestDb>;
  let pruneProjectLogs: typeof import('@/lib/jobs/retention').pruneProjectLogs;
  let getLatestProjectLogRetentionSummary: typeof import('@/lib/jobs/retention').getLatestProjectLogRetentionSummary;
  let getLatestNightlyRetentionSummary: typeof import('@/lib/jobs/retention').getLatestNightlyRetentionSummary;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-retention-'));
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    const mod = await import('@/lib/jobs/retention');
    pruneProjectLogs = mod.pruneProjectLogs;
    getLatestProjectLogRetentionSummary = mod.getLatestProjectLogRetentionSummary;
    getLatestNightlyRetentionSummary = mod.getLatestNightlyRetentionSummary;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function insertJob(id: string, project: string, startedAt: number, finishedAt: number | null, logPath: string | null) {
    testDb.db.insert(schema.jobs).values(makeJob(id, project, startedAt, finishedAt, logPath)).run();
  }

  const cfg: RetentionConfig = {
    log_retention_count: 3,
    log_retention_days: 30,
    job_row_retention_days: 180,
  };

  it('deletes log files beyond retention count', () => {
    const now = Date.now() / 1000;
    const logPaths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = join(tempDir, `log-${i}.ndjson`);
      writeFileSync(p, 'data');
      logPaths.push(p);
      insertJob(`proj-job-${i}`, 'proj', now - (5 - i) * 100, now - (5 - i) * 50, p);
    }

    const summary = pruneProjectLogs('proj', cfg);

    // Newest 3 (indices 2, 3, 4) should survive; oldest 2 (0, 1) pruned.
    expect(existsSync(logPaths[0])).toBe(false);
    expect(existsSync(logPaths[1])).toBe(false);
    expect(existsSync(logPaths[2])).toBe(true);
    expect(existsSync(logPaths[3])).toBe(true);
    expect(existsSync(logPaths[4])).toBe(true);
    expect(summary).toMatchObject({
      type: 'project_logs',
      project: 'proj',
      status: 'completed',
      rowsScanned: 5,
      rowsEligible: 2,
      rowsUpdated: 2,
      logFilesDeleted: 2,
      bytesReclaimed: 8,
      errorCount: 0,
    });
    expect(getLatestProjectLogRetentionSummary()).toMatchObject({ type: 'project_logs', rowsUpdated: 2 });
    expect(getLatestNightlyRetentionSummary()).toBeNull();
  });

  it('sets log_pruned=true on pruned rows', () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 5; i++) {
      const p = join(tempDir, `log-${i}.ndjson`);
      writeFileSync(p, 'data');
      insertJob(`proj-job-${i}`, 'proj', now - (5 - i) * 100, now - (5 - i) * 50, p);
    }

    pruneProjectLogs('proj', cfg);

    const rows = testDb.db.select({ id: schema.jobs.id, logPruned: schema.jobs.logPruned }).from(schema.jobs).all();
    const pruned = rows.filter(r => r.logPruned).map(r => r.id).sort();
    expect(pruned).toEqual(['proj-job-0', 'proj-job-1']);
  });

  it('deletes log files older than retention days', () => {
    vi.useFakeTimers();
    const now = Date.now() / 1000;
    const oldPath = join(tempDir, 'old.ndjson');
    const newPath = join(tempDir, 'new.ndjson');
    writeFileSync(oldPath, 'data');
    writeFileSync(newPath, 'data');

    const oldCfg: RetentionConfig = { log_retention_count: 1000, log_retention_days: 10, job_row_retention_days: 180 };

    // Old job: 20 days ago; new job: today.
    insertJob('proj-old', 'proj', now - 20 * 86400, now - 20 * 86400 + 60, oldPath);
    insertJob('proj-new', 'proj', now - 1, now, newPath);

    pruneProjectLogs('proj', oldCfg);

    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);

    vi.useRealTimers();
  });

  it('does not prune running (unfinished) jobs', () => {
    const now = Date.now() / 1000;
    const runningPath = join(tempDir, 'running.ndjson');
    writeFileSync(runningPath, 'data');
    insertJob('proj-running', 'proj', now - 1000, null, runningPath);
    // No other finished jobs, so retention count not exceeded anyway.
    // Insert enough finished jobs to trigger count pruning but not this one.
    for (let i = 0; i < 5; i++) {
      const p = join(tempDir, `fin-${i}.ndjson`);
      writeFileSync(p, 'data');
      insertJob(`proj-fin-${i}`, 'proj', now - (5 - i) * 100, now - (5 - i) * 50, p);
    }

    pruneProjectLogs('proj', cfg);

    // Running job's log must not be touched.
    expect(existsSync(runningPath)).toBe(true);
  });

  it('handles missing log files gracefully', () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 5; i++) {
      insertJob(`proj-job-${i}`, 'proj', now - (5 - i) * 100, now - (5 - i) * 50, join(tempDir, `missing-${i}.ndjson`));
    }
    // Should not throw even though files don't exist.
    expect(() => pruneProjectLogs('proj', cfg)).not.toThrow();
  });

  it('treats log_retention_days=0 as disabled (does not prune by age)', () => {
    const now = Date.now() / 1000;
    const ageOnlyCfg: RetentionConfig = { log_retention_count: 0, log_retention_days: 0, job_row_retention_days: 180 };
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = join(tempDir, `nodisable-${i}.ndjson`);
      writeFileSync(p, 'data');
      paths.push(p);
      // All jobs are old enough that a literal `now - 0*86400 = now` cutoff would mark them as over-age.
      insertJob(`proj-job-${i}`, 'proj', now - (i + 1) * 100, now - (i + 1) * 50, p);
    }

    const summary = pruneProjectLogs('proj', ageOnlyCfg);

    for (const p of paths) expect(existsSync(p)).toBe(true);
    const rows = testDb.db.select({ id: schema.jobs.id, logPruned: schema.jobs.logPruned }).from(schema.jobs).all();
    expect(rows.every(r => !r.logPruned)).toBe(true);
    expect(summary.status).toBe('disabled');
  });

  it('only prunes logs for the given project', () => {
    const now = Date.now() / 1000;
    const paths: Record<string, string[]> = { projA: [], projB: [] };
    for (const proj of ['projA', 'projB'] as const) {
      for (let i = 0; i < 5; i++) {
        const p = join(tempDir, `${proj}-${i}.ndjson`);
        writeFileSync(p, 'data');
        paths[proj].push(p);
        insertJob(`${proj}-job-${i}`, proj, now - (5 - i) * 100, now - (5 - i) * 50, p);
      }
    }

    pruneProjectLogs('projA', cfg);

    // projB logs should be untouched.
    for (const p of paths['projB']) {
      expect(existsSync(p)).toBe(true);
    }
  });
});

describe('runNightlyCleanup', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let runNightlyCleanup: typeof import('@/lib/jobs/retention').runNightlyCleanup;
  let getLatestProjectLogRetentionSummary: typeof import('@/lib/jobs/retention').getLatestProjectLogRetentionSummary;
  let getLatestNightlyRetentionSummary: typeof import('@/lib/jobs/retention').getLatestNightlyRetentionSummary;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    const mod = await import('@/lib/jobs/retention');
    runNightlyCleanup = mod.runNightlyCleanup;
    getLatestProjectLogRetentionSummary = mod.getLatestProjectLogRetentionSummary;
    getLatestNightlyRetentionSummary = mod.getLatestNightlyRetentionSummary;
  });

  afterEach(() => {
    vi.resetModules();
  });

  function insertJob(id: string, project: string, startedAt: number, finishedAt: number | null) {
    testDb.db.insert(schema.jobs).values(makeJob(id, project, startedAt, finishedAt, null)).run();
  }

  const cfg: RetentionConfig = {
    log_retention_count: 200,
    log_retention_days: 30,
    job_row_retention_days: 90,
  };

  it('deletes finished rows older than job_row_retention_days', () => {
    const now = Date.now() / 1000;
    insertJob('old-job', 'proj', now - 100 * 86400, now - 100 * 86400 + 60);
    insertJob('new-job', 'proj', now - 10, now);

    const summary = runNightlyCleanup(cfg);

    const rows = testDb.db.select({ id: schema.jobs.id }).from(schema.jobs).all();
    expect(rows.map(r => r.id)).toEqual(['new-job']);
    expect(summary).toMatchObject({
      type: 'nightly',
      status: 'completed',
      rowsScanned: 1,
      rowsDeleted: 1,
      skippedRunningRows: 0,
      errorCount: 0,
      sqliteMaintenance: {
        status: 'completed',
        checkpointRan: true,
        vacuumRan: true,
      },
    });
    expect(getLatestNightlyRetentionSummary()).toMatchObject({ type: 'nightly', rowsDeleted: 1 });
    expect(getLatestProjectLogRetentionSummary()).toBeNull();
  });

  it('does not delete running jobs even if started long ago', () => {
    const now = Date.now() / 1000;
    insertJob('long-running', 'proj', now - 200 * 86400, null);
    insertJob('old-job', 'proj', now - 100 * 86400, now - 100 * 86400 + 60);

    const summary = runNightlyCleanup(cfg);

    const rows = testDb.db.select({ id: schema.jobs.id }).from(schema.jobs).all();
    expect(rows.map(r => r.id)).toEqual(['long-running']);
    expect(summary.skippedRunningRows).toBe(1);
    expect(summary.sqliteMaintenance).toMatchObject({
      status: 'skipped',
      reason: 'active_jobs',
      activeJobs: 1,
      checkpointRan: false,
      vacuumRan: false,
    });
  });

  it('treats job_row_retention_days=0 as disabled (does not delete anything)', () => {
    const now = Date.now() / 1000;
    insertJob('very-old', 'proj', now - 1000 * 86400, now - 1000 * 86400 + 60);
    insertJob('old', 'proj', now - 100 * 86400, now - 100 * 86400 + 60);

    const summary = runNightlyCleanup({ log_retention_count: 200, log_retention_days: 30, job_row_retention_days: 0 });

    const rows = testDb.db.select({ id: schema.jobs.id }).from(schema.jobs).all();
    expect(rows.map(r => r.id).sort()).toEqual(['old', 'very-old']);
    expect(summary.status).toBe('disabled');
    expect(summary.sqliteMaintenance).toMatchObject({ status: 'skipped', reason: 'no_deleted_rows' });
  });

  it('does not delete rows within retention window', () => {
    const now = Date.now() / 1000;
    insertJob('recent-job', 'proj', now - 5 * 86400, now - 5 * 86400 + 60);

    runNightlyCleanup(cfg);

    const rows = testDb.db.select({ id: schema.jobs.id }).from(schema.jobs).all();
    expect(rows.map(r => r.id)).toEqual(['recent-job']);
  });

  it('keeps nightly and project log summaries in separate maintenance records', async () => {
    const now = Date.now() / 1000;
    const tempDir = mkdtempSync(join(tmpdir(), 'tamtam-retention-cross-'));
    const oldLogPath = join(tempDir, 'old.ndjson');
    const newLogPath = join(tempDir, 'new.ndjson');
    writeFileSync(oldLogPath, 'data');
    writeFileSync(newLogPath, 'data');

    try {
      testDb.db.insert(schema.jobs).values(makeJob('proj-old-log', 'proj', now - 120, now - 60, oldLogPath)).run();
      testDb.db.insert(schema.jobs).values(makeJob('proj-new-log', 'proj', now - 10, now, newLogPath)).run();
      insertJob('old-row', 'proj', now - 100 * 86400, now - 100 * 86400 + 60);

      const mod = await import('@/lib/jobs/retention');
      mod.runNightlyCleanup(cfg);
      mod.pruneProjectLogs('proj', { ...cfg, log_retention_count: 1, log_retention_days: 30 });

      expect(mod.getLatestNightlyRetentionSummary()).toMatchObject({
        type: 'nightly',
        rowsDeleted: 1,
      });
      expect(mod.getLatestProjectLogRetentionSummary()).toMatchObject({
        type: 'project_logs',
        rowsUpdated: 1,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
