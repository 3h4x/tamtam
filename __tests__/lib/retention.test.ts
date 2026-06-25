import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { RetentionConfig } from '@/lib/jobs/retention';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY,
      project text NOT NULL,
      kind text NOT NULL,
      prompt text,
      pid integer NOT NULL,
      log_path text,
      started_at double precision NOT NULL,
      finished_at double precision,
      exit_code integer,
      seen boolean DEFAULT false,
      duration_ms integer,
      input_tokens integer,
      output_tokens integer,
      cache_read_tokens integer,
      cache_create_tokens integer,
      session_id text,
      user_prompt text,
      context_meta text,
      parent_job_id text,
      gh_issue_number integer,
      gh_issue_repo text,
      gh_issue_title text,
      log_pruned boolean DEFAULT false,
      verdict text,
      cost_usd double precision,
      model text,
      release_id text,
      aborted_at double precision,
      release_deadline_at integer,
      prompt_bytes integer,
      work_summary text,
      modified_files text,
      lines_added integer,
      lines_removed integer,
      provider text,
      run_score integer,
      skill_ids text NOT NULL DEFAULT '[]'
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS maintenance_status (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS skill_revisions (
      id serial PRIMARY KEY,
      entity_id text NOT NULL,
      snapshot text NOT NULL,
      author text NOT NULL,
      note text,
      created_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS agent_revisions (
      id serial PRIMARY KEY,
      entity_id text NOT NULL,
      snapshot text NOT NULL,
      author text NOT NULL,
      note text,
      created_at double precision NOT NULL
    )
  `));
}

let sharedHandle: TestDbHandle;

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyDdl(sharedHandle);
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 30));
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

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
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let tempDir: string;
  let pruneProjectLogs: typeof import('@/lib/jobs/retention').pruneProjectLogs;
  let getLatestProjectLogRetentionSummary: typeof import('@/lib/jobs/retention').getLatestProjectLogRetentionSummary;
  let getLatestNightlyRetentionSummary: typeof import('@/lib/jobs/retention').getLatestNightlyRetentionSummary;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-retention-'));
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE jobs, maintenance_status, skill_revisions, agent_revisions RESTART IDENTITY'));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/jobs/retention');
    pruneProjectLogs = mod.pruneProjectLogs;
    getLatestProjectLogRetentionSummary = mod.getLatestProjectLogRetentionSummary;
    getLatestNightlyRetentionSummary = mod.getLatestNightlyRetentionSummary;
  });

  afterEach(async () => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function insertJob(id: string, project: string, startedAt: number, finishedAt: number | null, logPath: string | null) {
    const job = makeJob(id, project, startedAt, finishedAt, logPath);
    await handle.db.insert(schema.jobs).values(job);
  }

  const cfg: RetentionConfig = {
    log_retention_count: 3,
    log_retention_days: 30,
    job_row_retention_days: 180,
  };

  it('deletes log files beyond retention count', async () => {
    const now = Date.now() / 1000;
    const logPaths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = join(tempDir, `log-${i}.ndjson`);
      writeFileSync(p, 'data');
      logPaths.push(p);
      await insertJob(`proj-job-${i}`, 'proj', now - (5 - i) * 100, now - (5 - i) * 50, p);
    }

    const summary = await pruneProjectLogs('proj', cfg);

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
    expect(await getLatestProjectLogRetentionSummary()).toMatchObject({ type: 'project_logs', rowsUpdated: 2 });
    expect(await getLatestNightlyRetentionSummary()).toBeNull();
  });

  it('sets log_pruned=true on pruned rows', async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 5; i++) {
      const p = join(tempDir, `log-${i}.ndjson`);
      writeFileSync(p, 'data');
      await insertJob(`proj-job-${i}`, 'proj', now - (5 - i) * 100, now - (5 - i) * 50, p);
    }

    await pruneProjectLogs('proj', cfg);

    const rows = await handle.db.select({ id: schema.jobs.id, logPruned: schema.jobs.logPruned }).from(schema.jobs);
    const pruned = rows.filter((r) => r.logPruned).map((r) => r.id).sort();
    expect(pruned).toEqual(['proj-job-0', 'proj-job-1']);
  });

  it('deletes log files older than retention days', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now() / 1000;
      const oldPath = join(tempDir, 'old.ndjson');
      const newPath = join(tempDir, 'new.ndjson');
      writeFileSync(oldPath, 'data');
      writeFileSync(newPath, 'data');

      const oldCfg: RetentionConfig = { log_retention_count: 1000, log_retention_days: 10, job_row_retention_days: 180 };

      // Old job: 20 days ago; new job: today.
      await insertJob('proj-old', 'proj', now - 20 * 86400, now - 20 * 86400 + 60, oldPath);
      await insertJob('proj-new', 'proj', now - 1, now, newPath);

      await pruneProjectLogs('proj', oldCfg);

      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(newPath)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not prune running (unfinished) jobs', async () => {
    const now = Date.now() / 1000;
    const runningPath = join(tempDir, 'running.ndjson');
    writeFileSync(runningPath, 'data');
    await insertJob('proj-running', 'proj', now - 1000, null, runningPath);
    // No other finished jobs, so retention count not exceeded anyway.
    // Insert enough finished jobs to trigger count pruning but not this one.
    for (let i = 0; i < 5; i++) {
      const p = join(tempDir, `fin-${i}.ndjson`);
      writeFileSync(p, 'data');
      await insertJob(`proj-fin-${i}`, 'proj', now - (5 - i) * 100, now - (5 - i) * 50, p);
    }

    await pruneProjectLogs('proj', cfg);

    // Running job's log must not be touched.
    expect(existsSync(runningPath)).toBe(true);
  });

  it('handles missing log files gracefully', async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 5; i++) {
      await insertJob(`proj-job-${i}`, 'proj', now - (5 - i) * 100, now - (5 - i) * 50, join(tempDir, `missing-${i}.ndjson`));
    }
    // Should not throw even though files don't exist.
    await expect(pruneProjectLogs('proj', cfg)).resolves.toBeDefined();
  });

  it('treats a log removed during pruning as already pruned', async () => {
    const now = Date.now() / 1000;
    const stalePath = join(tempDir, 'stale.ndjson');
    const keptPath = join(tempDir, 'kept.ndjson');
    writeFileSync(stalePath, 'data');
    writeFileSync(keptPath, 'data');
    await insertJob('proj-stale', 'proj', now - 200, now - 150, stalePath);
    await insertJob('proj-kept', 'proj', now - 20, now - 10, keptPath);

    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0]) => {
          if (path === stalePath) {
            const error = new Error('missing') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return actual.unlinkSync(path);
        },
      };
    });

    try {
      const mod = await import('@/lib/jobs/retention');
      const summary = await mod.pruneProjectLogs('proj', { ...cfg, log_retention_count: 1 });

      expect(summary).toMatchObject({
        status: 'completed',
        rowsEligible: 1,
        rowsUpdated: 1,
        logFilesDeleted: 0,
        bytesReclaimed: 0,
        errorCount: 0,
      });
      const rows = await handle.db.select({ id: schema.jobs.id, logPruned: schema.jobs.logPruned }).from(schema.jobs);
      expect(rows.find((r) => r.id === 'proj-stale')?.logPruned).toBe(true);
    } finally {
      vi.doUnmock('fs');
    }
  });

  it('treats log_retention_days=0 as disabled (does not prune by age)', async () => {
    const now = Date.now() / 1000;
    const ageOnlyCfg: RetentionConfig = { log_retention_count: 0, log_retention_days: 0, job_row_retention_days: 180 };
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = join(tempDir, `nodisable-${i}.ndjson`);
      writeFileSync(p, 'data');
      paths.push(p);
      // All jobs are old enough that a literal `now - 0*86400 = now` cutoff would mark them as over-age.
      await insertJob(`proj-job-${i}`, 'proj', now - (i + 1) * 100, now - (i + 1) * 50, p);
    }

    const summary = await pruneProjectLogs('proj', ageOnlyCfg);

    for (const p of paths) expect(existsSync(p)).toBe(true);
    const rows = await handle.db.select({ id: schema.jobs.id, logPruned: schema.jobs.logPruned }).from(schema.jobs);
    expect(rows.every((r) => !r.logPruned)).toBe(true);
    expect(summary.status).toBe('disabled');
  });

  it('only prunes logs for the given project', async () => {
    const now = Date.now() / 1000;
    const paths: Record<string, string[]> = { projA: [], projB: [] };
    for (const proj of ['projA', 'projB'] as const) {
      for (let i = 0; i < 5; i++) {
        const p = join(tempDir, `${proj}-${i}.ndjson`);
        writeFileSync(p, 'data');
        paths[proj].push(p);
        await insertJob(`${proj}-job-${i}`, proj, now - (5 - i) * 100, now - (5 - i) * 50, p);
      }
    }

    await pruneProjectLogs('projA', cfg);

    // projB logs should be untouched.
    for (const p of paths['projB']) {
      expect(existsSync(p)).toBe(true);
    }
  });
});

describe('runNightlyCleanup', () => {
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let runNightlyCleanup: typeof import('@/lib/jobs/retention').runNightlyCleanup;
  let getLatestProjectLogRetentionSummary: typeof import('@/lib/jobs/retention').getLatestProjectLogRetentionSummary;
  let getLatestNightlyRetentionSummary: typeof import('@/lib/jobs/retention').getLatestNightlyRetentionSummary;

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE jobs, maintenance_status, skill_revisions, agent_revisions RESTART IDENTITY'));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/jobs/retention');
    runNightlyCleanup = mod.runNightlyCleanup;
    getLatestProjectLogRetentionSummary = mod.getLatestProjectLogRetentionSummary;
    getLatestNightlyRetentionSummary = mod.getLatestNightlyRetentionSummary;
  });

  afterEach(async () => {
    vi.resetModules();
  });

  async function insertJob(id: string, project: string, startedAt: number, finishedAt: number | null) {
    const job = makeJob(id, project, startedAt, finishedAt, null);
    await handle.db.insert(schema.jobs).values(job);
  }

  const cfg: RetentionConfig = {
    log_retention_count: 200,
    log_retention_days: 30,
    job_row_retention_days: 90,
  };

  it('deletes finished rows older than job_row_retention_days', async () => {
    const now = Date.now() / 1000;
    await insertJob('old-job', 'proj', now - 100 * 86400, now - 100 * 86400 + 60);
    await insertJob('new-job', 'proj', now - 10, now);

    const summary = await runNightlyCleanup(cfg);

    const rows = await handle.db.select({ id: schema.jobs.id }).from(schema.jobs);
    expect(rows.map((r) => r.id)).toEqual(['new-job']);
    expect(summary).toMatchObject({
      type: 'nightly',
      status: 'completed',
      rowsScanned: 1,
      rowsDeleted: 1,
      skippedRunningRows: 0,
      errorCount: 0,
    });
    expect(await getLatestNightlyRetentionSummary()).toMatchObject({ type: 'nightly', rowsDeleted: 1 });
    expect(await getLatestProjectLogRetentionSummary()).toBeNull();
  });

  it('does not delete running jobs even if started long ago', async () => {
    const now = Date.now() / 1000;
    await insertJob('long-running', 'proj', now - 200 * 86400, null);
    await insertJob('old-job', 'proj', now - 100 * 86400, now - 100 * 86400 + 60);

    const summary = await runNightlyCleanup(cfg);

    const rows = await handle.db.select({ id: schema.jobs.id }).from(schema.jobs);
    expect(rows.map((r) => r.id)).toEqual(['long-running']);
    expect(summary.skippedRunningRows).toBe(1);
  });

  it('treats job_row_retention_days=0 as disabled (does not delete anything)', async () => {
    const now = Date.now() / 1000;
    await insertJob('very-old', 'proj', now - 1000 * 86400, now - 1000 * 86400 + 60);
    await insertJob('old', 'proj', now - 100 * 86400, now - 100 * 86400 + 60);

    const summary = await runNightlyCleanup({ log_retention_count: 200, log_retention_days: 30, job_row_retention_days: 0 });

    const rows = await handle.db.select({ id: schema.jobs.id }).from(schema.jobs);
    expect(rows.map((r) => r.id).sort()).toEqual(['old', 'very-old']);
    expect(summary.status).toBe('disabled');
  });

  it('prunes skill and agent revisions beyond the per-entity retention count', async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 4; i++) {
      await handle.db.insert(schema.skillRevisions).values({
        entityId: 'skill-1',
        snapshot: JSON.stringify({ id: 'skill-1', content: `skill-${i}` }),
        author: 'tester',
        note: null,
        createdAt: now + i,
      });
      await handle.db.insert(schema.agentRevisions).values({
        entityId: 'agent-1',
        snapshot: JSON.stringify({ id: 'agent-1', prompt: `agent-${i}` }),
        author: 'tester',
        note: null,
        createdAt: now + i,
      });
    }

    const summary = await runNightlyCleanup({
      log_retention_count: 200,
      log_retention_days: 30,
      job_row_retention_days: 0,
      skill_revision_retention_count: 2,
    });

    const skillRows = await handle.db.select().from(schema.skillRevisions);
    const agentRows = await handle.db.select().from(schema.agentRevisions);
    expect(summary.revisionRowsDeleted).toBe(4);
    expect(skillRows.map((row) => JSON.parse(row.snapshot).content).sort()).toEqual(['skill-2', 'skill-3']);
    expect(agentRows.map((row) => JSON.parse(row.snapshot).prompt).sort()).toEqual(['agent-2', 'agent-3']);
  });

  it('does not delete rows within retention window', async () => {
    const now = Date.now() / 1000;
    await insertJob('recent-job', 'proj', now - 5 * 86400, now - 5 * 86400 + 60);

    await runNightlyCleanup(cfg);

    const rows = await handle.db.select({ id: schema.jobs.id }).from(schema.jobs);
    expect(rows.map((r) => r.id)).toEqual(['recent-job']);
  });

  it('keeps nightly and project log summaries in separate maintenance records', async () => {
    const now = Date.now() / 1000;
    const tempDir = mkdtempSync(join(tmpdir(), 'tamtam-retention-cross-'));
    const oldLogPath = join(tempDir, 'old.ndjson');
    const newLogPath = join(tempDir, 'new.ndjson');
    writeFileSync(oldLogPath, 'data');
    writeFileSync(newLogPath, 'data');

    try {
      await handle.db.insert(schema.jobs).values(makeJob('proj-old-log', 'proj', now - 120, now - 60, oldLogPath));
      await handle.db.insert(schema.jobs).values(makeJob('proj-new-log', 'proj', now - 10, now, newLogPath));
      await insertJob('old-row', 'proj', now - 100 * 86400, now - 100 * 86400 + 60);

      const mod = await import('@/lib/jobs/retention');
      await mod.runNightlyCleanup(cfg);
      await mod.pruneProjectLogs('proj', { ...cfg, log_retention_count: 1, log_retention_days: 30 });

      expect(await mod.getLatestNightlyRetentionSummary()).toMatchObject({
        type: 'nightly',
        rowsDeleted: 1,
      });
      expect(await mod.getLatestProjectLogRetentionSummary()).toMatchObject({
        type: 'project_logs',
        rowsUpdated: 1,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
