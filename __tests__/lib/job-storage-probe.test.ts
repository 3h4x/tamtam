import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import { JobData } from '@/lib/jobs/job-storage';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
      run_score integer
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
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
    CREATE TABLE IF NOT EXISTS job_completion_events (
      id serial PRIMARY KEY,
      job_id text NOT NULL UNIQUE,
      kind text NOT NULL,
      exit_code integer,
      project text NOT NULL,
      release_id text,
      gh_issue_number integer,
      emitted_at double precision NOT NULL,
      consumed_by text,
      consumed_at double precision
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id text PRIMARY KEY,
      project text NOT NULL,
      source_kind text NOT NULL,
      source_id text,
      agent_id text,
      agent_name text,
      type text NOT NULL,
      title text NOT NULL,
      detail text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      payload text,
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS gh_issues_cache (
      project text PRIMARY KEY,
      repo text NOT NULL,
      prs text NOT NULL DEFAULT '[]',
      issues text NOT NULL DEFAULT '[]',
      fetched_at double precision NOT NULL
    )
  `));
}

let sharedHandle: TestDbHandle;

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyDdl(sharedHandle);
});

afterAll(async () => {
  // Drain any straggling fire-and-forget queries via a no-op SELECT before
  // closing. PGlite serializes queries on a single instance, so awaiting a
  // SELECT 1 flushes anything queued ahead of it without a fixed sleep.
  try {
    await sharedHandle.db.execute(sql.raw('SELECT 1'));
  } catch {
    // ignore
  }
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

async function truncateAll(): Promise<void> {
  // DELETE is faster than TRUNCATE on PGlite for small tables (no table rewrite,
  // no extension reload). Single execute() with multi-statement is rejected by
  // PGlite, so issue them via a single CTE-style query.
  await sharedHandle.db.execute(sql.raw(
    'WITH a AS (DELETE FROM jobs RETURNING 1), b AS (DELETE FROM recommendations RETURNING 1), c AS (DELETE FROM settings RETURNING 1), d AS (DELETE FROM maintenance_status RETURNING 1), e AS (DELETE FROM job_completion_events RETURNING 1) DELETE FROM gh_issues_cache'
  ));
}

// Getter shim so existing `testDb.db.*` test code keeps working while the
// underlying connection is the shared PGlite handle.
const testDb = {
  get db() {
    return sharedHandle.db;
  },
} as { db: TestDbHandle['db'] };

function makeMissingProcessError(): NodeJS.ErrnoException {
  const error = new Error('ESRCH') as NodeJS.ErrnoException;
  error.code = 'ESRCH';
  return error;
}

describe('probeJobStatus', () => {
  let probeJobStatusFn: typeof import('@/lib/jobs/job-storage').probeJobStatus;
  const resolveProjectPathMock = vi.fn();
  let storageCache: Map<string, JobData>;
  let tempDir: string;
  let jobSeq = 0;

  function nextJobId(label: string): string {
    return `${label}-${++jobSeq}`;
  }

  function writeProbeLog(name: string, contents: string): string {
    const logFile = join(tempDir, `${name}-${++jobSeq}.log`);
    writeFileSync(logFile, contents);
    return logFile;
  }

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));

    const mod = await import('@/lib/jobs/job-storage');
    probeJobStatusFn = mod.probeJobStatus;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-probe-status-'));
  });

  beforeEach(async () => {
    storageCache.clear();
    resolveProjectPathMock.mockReset().mockReturnValue(null);
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/project-data');
    vi.resetModules();
  });

  it('returns running for pid>0 jobs whose process is still alive', async () => {
    const job: JobData = {
      id: nextJobId('job-alive'),
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: process.pid, // guaranteed alive
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
    expect(job.finishedAt).toBeNull();
  });

  it('marks done for pid>0 jobs whose process is gone', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw makeMissingProcessError();
    });
    const job: JobData = {
      id: nextJobId('job-dead'),
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 99999,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      const status = await probeJobStatusFn(job);
      expect(status).toBe('done');
      expect(job.finishedAt).not.toBeNull();
      expect(job.exitCode).toBe(-1);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('marks done via process.kill when pid no longer exists', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw makeMissingProcessError();
    });

    const job: JobData = {
      id: nextJobId('job-dead-pid'),
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 99999,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      const status = await probeJobStatusFn(job);
      expect(status).toBe('done');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('marks done with exit 0 when log has a clean claude result line (is_error:false)', async () => {
    const resultLine = '{"type":"result","subtype":"success","is_error":false,"duration_ms":500,"total_cost_usd":0,"session_id":"s1","result":"ok"}';
    const logFile = writeProbeLog('exitcode-override', resultLine + '\n');

    const job: JobData = {
      id: nextJobId('job-override'),
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 9999,
      logPath: logFile,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    // getClaudeResultExitCode fires first: log has "type":"result" with is_error:false → markDone(0)
    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(0);
  });

  it('uses exit code 1 when log result has is_error:true (e.g. API timeout)', async () => {
    const resultLine = '{"type":"result","subtype":"error_max_turns","is_error":true,"duration_ms":1000,"total_cost_usd":0,"session_id":"s2","result":"Stream idle timeout"}';
    const logFile = writeProbeLog('is-error', resultLine + '\n');

    const job: JobData = {
      id: nextJobId('job-is-error'),
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 9999,
      logPath: logFile,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    // getClaudeResultExitCode fires first: log has "type":"result" with is_error:true → markDone(1)
    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(1);
  });

  it('uses exit code 1 for is_error:true on agent: kind too', async () => {
    const resultLine = '{"type":"result","subtype":"error_api","is_error":true,"duration_ms":500,"total_cost_usd":0,"session_id":"s3","result":"Rate limited"}';
    const logFile = writeProbeLog('agent-is-error', resultLine + '\n');

    const job: JobData = {
      id: nextJobId('job-agent-is-error'),
      project: 'proj',
      kind: 'agent:my-agent',
      prompt: null,
      pid: 9999,
      logPath: logFile,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(1);
  });

  it('does NOT apply claude result-line override for test kind', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw makeMissingProcessError();
    });

    const resultLine = '{"type":"result","subtype":"success","is_error":false,"duration_ms":200,"total_cost_usd":0,"session_id":"s3","result":"ok"}';
    const logFile = writeProbeLog('test-kind', resultLine + '\n');

    const job: JobData = {
      id: nextJobId('job-test-kind'),
      project: 'proj',
      kind: 'test',
      prompt: null,
      pid: 9999,
      logPath: logFile,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      // The claude result-line override only fires for claude-backed kinds.
      // Test kind falls through to process.kill liveness; dead pid + no
      // sentinel file → markDone(-1).
      const status = await probeJobStatusFn(job);
      expect(status).toBe('done');
      expect(job.exitCode).toBe(-1);
    } finally {
      killSpy.mockRestore();
    }
  });

  // Regression: an `agent:*` job created via createJob(project, kind, 0, '')
  // spends hundreds of ms before updateJob persists the real pid. A concurrent
  // duplicate-check (/api/agents/[id]/run) would call probeJobStatus on the
  // in-flight sibling, hit the pid<=0 fast-path, and markDone(-1) — which
  // also tears down the nascent process. User symptom: phantom
  // "exit -1 @ 0s" row next to the successful run.
  it("returns 'running' for a freshly-created pid=0 job (spawn grace)", async () => {
    const job: JobData = {
      id: nextJobId('job-spawn-grace'),
      project: 'proj',
      kind: 'agent:docs',
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
    expect(job.finishedAt).toBeNull();
    expect(job.exitCode).toBeNull();
  });

  it("returns 'done' and marks exit -1 once a pid=0 job exceeds the spawn grace", async () => {
    const job: JobData = {
      id: nextJobId('job-spawn-grace-expired'),
      project: 'proj',
      kind: 'agent:docs',
      prompt: null,
      pid: 0,
      logPath: null,
      // 60 s ago — well past the 30 s grace window.
      startedAt: Date.now() / 1000 - 60,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(-1);
    expect(job.finishedAt).not.toBeNull();
  });

  it("returns 'running' for a freshly-created pid=-1 job (negative pid within grace)", async () => {
    // pid can be -1 when createJob writes a placeholder before the spawn
    // returns. The grace window applies to all pid<=0, not just pid===0.
    const job: JobData = {
      id: nextJobId('job-spawn-grace-neg'),
      project: 'proj',
      kind: 'agent:docs',
      prompt: null,
      pid: -1,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
    expect(job.finishedAt).toBeNull();
  });

  it("returns 'done' for a pid=-1 job that exceeds the spawn grace", async () => {
    const job: JobData = {
      id: nextJobId('job-spawn-grace-neg-expired'),
      project: 'proj',
      kind: 'agent:docs',
      prompt: null,
      pid: -1,
      logPath: null,
      startedAt: Date.now() / 1000 - 60,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(-1);
    expect(job.finishedAt).not.toBeNull();
  });

  it('release kind always reports running — workflow runtime owns finalization', async () => {
    const job: JobData = {
      id: nextJobId('release-running'),
      project: 'proj',
      kind: 'release',
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: Date.now() / 1000 - 120,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
    expect(job.finishedAt).toBeNull();
  });
});
describe('probeJobStatus – test/action kind liveness via process.kill', () => {
  let probeJobStatusFn: typeof import('@/lib/jobs/job-storage').probeJobStatus;
  let storageCache: Map<string, JobData>;
  let jobSeq = 0;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue(null) }));

    const mod = await import('@/lib/jobs/job-storage');
    probeJobStatusFn = mod.probeJobStatus;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
  });

  beforeEach(async () => {
    storageCache.clear();
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/project-data');
    vi.resetModules();
  });

  it('test kind with live pid returns running', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as ReturnType<typeof process.kill>);
    const job: JobData = {
      id: `job-test-live-${++jobSeq}`,
      project: 'proj',
      kind: 'test',
      prompt: null,
      pid: 99999,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      const status = await probeJobStatusFn(job);
      expect(status).toBe('running');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('action kind with live pid returns running', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as ReturnType<typeof process.kill>);
    const job: JobData = {
      id: `job-action-live-${++jobSeq}`,
      project: 'proj',
      kind: 'action',
      prompt: null,
      pid: 99999,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      const status = await probeJobStatusFn(job);
      expect(status).toBe('running');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('test kind with dead pid returns done', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw makeMissingProcessError();
    });
    const job: JobData = {
      id: `job-test-dead-${++jobSeq}`,
      project: 'proj',
      kind: 'test',
      prompt: null,
      pid: 99999,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      const status = await probeJobStatusFn(job);
      expect(status).toBe('done');
    } finally {
      killSpy.mockRestore();
    }
  });
});
describe('markDone – ghIssuesCache invalidation', () => {
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;

  function makeJob(project: string, kind = 'run'): JobData {
    return {
      id: `${project}-${kind}-cache-test`,
      project,
      kind,
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    };
  }

  async function insertCacheRow(project: string) {
    await testDb.db.insert(schema.ghIssuesCache).values({
      project,
      repo: `owner/${project}`,
      prs: '[]',
      issues: '[]',
      fetchedAt: Date.now() / 1000,
    });
  }

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/proj'),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({ autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false }),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/push-rejection', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      isRemoteRaceRejection: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/pipeline/start-release', () => ({
      startRelease: vi.fn().mockResolvedValue({ ok: false }),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
  });

  beforeEach(async () => {
    storageCache.clear();
    await truncateAll();
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/pipeline/push-rejection');
    vi.doUnmock('@/lib/pipeline/start-release');
    vi.resetModules();
  });

  it('deletes the ghIssuesCache row for the job project on markDone', async () => {
    await insertCacheRow('my-proj');
    const before = await testDb.db.select().from(schema.ghIssuesCache);
    expect(before).toHaveLength(1);

    const job = makeJob('my-proj');
    await markDoneFn(job, 0);

    const after = await testDb.db.select().from(schema.ghIssuesCache);
    expect(after).toHaveLength(0);
  });

  it('does not delete cache rows for other projects', async () => {
    await insertCacheRow('proj-a');
    await insertCacheRow('proj-b');

    const job = makeJob('proj-a');
    await markDoneFn(job, 0);

    const remaining = await testDb.db.select().from(schema.ghIssuesCache);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].project).toBe('proj-b');
  });

  it('succeeds silently when no cache row exists for the project', async () => {
    const job = makeJob('no-cache-proj');
    await expect(markDoneFn(job, 0)).resolves.toBeUndefined();
  });

  it('invalidates cache regardless of exit code', async () => {
    await insertCacheRow('failing-proj');
    const job = makeJob('failing-proj');
    await markDoneFn(job, 1);

    const after = await testDb.db.select().from(schema.ghIssuesCache);
    expect(after).toHaveLength(0);
  });
});
describe('markDone – metadata extraction skipped for release kind', () => {
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let tempDir: string;
  let jobSeq = 0;

  const resultLine = '{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"session_id":"ses-abc","result":"ok","modelUsage":{"claude-sonnet":{"inputTokens":100,"outputTokens":50,"cacheReadInputTokens":10,"cacheCreationInputTokens":5}}}';

  function makeJob(kind: string, logPath: string | null): JobData {
    return {
      id: `${kind.replace(':', '-')}-meta-test-${++jobSeq}`,
      project: 'meta-proj',
      kind,
      prompt: null,
      pid: 1,
      logPath,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    };
  }

  let storageCache: Map<string, JobData>;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({ autoPushEnabled: false }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/push-rejection', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      isRemoteRaceRejection: vi.fn().mockReturnValue(false),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-meta-'));
  });

  beforeEach(async () => {
    storageCache.clear();
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/push-rejection');
    vi.resetModules();
  });

  it('does NOT populate sessionId/tokens for release kind even when log has a result line', async () => {
    const logFile = join(tempDir, 'release.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('release', logFile);

    await markDoneFn(job, 0);

    expect(job.sessionId).toBeNull();
    expect(job.inputTokens).toBeNull();
    expect(job.outputTokens).toBeNull();
    expect(job.cacheReadTokens).toBeNull();
    expect(job.cacheCreateTokens).toBeNull();
    expect(job.durationMs).toBeNull();
  });

  it('DOES populate sessionId/tokens for non-release kinds (review)', async () => {
    const logFile = join(tempDir, 'review.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('review', logFile);

    await markDoneFn(job, 0);

    expect(job.sessionId).toBe('ses-abc');
    expect(job.inputTokens).toBe(100);
    expect(job.outputTokens).toBe(50);
    expect(job.cacheReadTokens).toBe(10);
    expect(job.cacheCreateTokens).toBe(5);
    expect(job.durationMs).toBe(1234);
  });

  it('DOES populate metadata for commit kind (non-release Claude job)', async () => {
    const logFile = join(tempDir, 'commit.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('commit', logFile);

    await markDoneFn(job, 0);

    expect(job.sessionId).toBe('ses-abc');
    expect(job.durationMs).toBe(1234);
  });

  it('populates model and costUsd from modelUsage for non-release kinds', async () => {
    const logFile = join(tempDir, 'run-cost.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('run', logFile);

    await markDoneFn(job, 0);

    expect(job.model).toBe('claude-sonnet');
    expect(typeof job.costUsd).toBe('number');
    expect(job.costUsd).toBeGreaterThan(0);
  });

  it('persists costUsd and model to DB after markDone', async () => {
    const logFile = join(tempDir, 'run-db.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('run', logFile);
    await testDb.db.insert(schema.jobs).values({
      id: job.id, project: job.project, kind: job.kind,
      prompt: null, pid: job.pid, logPath: logFile,
      startedAt: job.startedAt, finishedAt: null, exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    await markDoneFn(job, 0);

    const row = (await testDb.db.select().from(schema.jobs)).find(r => r.id === job.id);
    expect(row?.model).toBe('claude-sonnet');
    expect(row?.costUsd).toBeGreaterThan(0);
  });

  it('does NOT populate model or costUsd for release kind', async () => {
    const logFile = join(tempDir, 'release-cost.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('release', logFile);

    await markDoneFn(job, 0);

    expect(job.model).toBeUndefined();
    expect(job.costUsd).toBeUndefined();
  });
});
describe('markDone – DB-level idempotency guard', () => {
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  const startProjectReviewMock = vi.fn();
  const startProjectPushMock = vi.fn();
  let storageCache: Map<string, JobData>;

  function makeJob(id: string, kind = 'push'): JobData {
    return {
      id,
      project: 'guard-proj',
      kind,
      prompt: null,
      pid: 999,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    };
  }

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      markReviewed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getProjectTestConfig: vi.fn().mockReturnValue({ autoPushEnabled: false }),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: startProjectReviewMock,
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: startProjectPushMock,
    }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: vi.fn().mockResolvedValue({ ok: false, detail: 'guard' }),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: vi.fn().mockResolvedValue({ ok: false, detail: 'guard' }),
    }));
    vi.doMock('@/lib/pipeline/push-rejection', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      isRemoteRaceRejection: vi.fn().mockReturnValue(false),
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
  });

  beforeEach(async () => {
    storageCache.clear();
    await truncateAll();
    startProjectReviewMock.mockReset().mockResolvedValue({ ok: false, detail: 'guard' });
    startProjectPushMock.mockReset().mockResolvedValue({ ok: false, detail: 'guard' });
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-commit');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/pipeline/push-rejection');
    vi.resetModules();
  });

  it('returns early and syncs finishedAt when DB row is already finalized', async () => {
    const alreadyFinishedAt = Date.now() / 1000 - 60;
    await testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-1', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: alreadyFinishedAt - 10,
      finishedAt: alreadyFinishedAt,
      exitCode: 0,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    const job = makeJob('db-guard-job-1');
    // Stale in-memory object: finishedAt is null even though DB says it's done
    expect(job.finishedAt).toBeNull();

    await markDoneFn(job, 0);

    // job.finishedAt must be synced from DB
    expect(job.finishedAt).toBe(alreadyFinishedAt);
    // No completion hooks should fire (no push/review triggered)
    expect(startProjectPushMock).not.toHaveBeenCalled();
    expect(startProjectReviewMock).not.toHaveBeenCalled();
  });

  it('does not overwrite the DB finishedAt when returning early from DB guard', async () => {
    const alreadyFinishedAt = Date.now() / 1000 - 60;
    await testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-2', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: alreadyFinishedAt - 10,
      finishedAt: alreadyFinishedAt,
      exitCode: 0,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    const job = makeJob('db-guard-job-2');
    await markDoneFn(job, 99);

    const row = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'db-guard-job-2');
    // DB row should still have the original finishedAt, not a new one
    expect(row?.finishedAt).toBe(alreadyFinishedAt);
    expect(row?.exitCode).toBe(0); // not overwritten with 99
  });

  it('proceeds normally when DB row has finishedAt = null', async () => {
    await testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-3', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: Date.now() / 1000 - 5,
      finishedAt: null,
      exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    const job = makeJob('db-guard-job-3');
    await markDoneFn(job, 0);

    expect(job.finishedAt).not.toBeNull();
    const row = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'db-guard-job-3');
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(0);
  });

  it('lets only one concurrent caller claim a null-finished DB row', async () => {
    await testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-concurrent', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: Date.now() / 1000 - 5,
      finishedAt: null,
      exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    const first = makeJob('db-guard-job-concurrent');
    const second = makeJob('db-guard-job-concurrent');

    await Promise.all([
      markDoneFn(first, 0),
      markDoneFn(second, 99),
    ]);

    const row = (await testDb.db.select().from(schema.jobs)).find(r => r.id === 'db-guard-job-concurrent');
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.exitCode).toBe(0);
    expect(first.finishedAt).toBe(row?.finishedAt);
    expect(second.finishedAt).toBe(row?.finishedAt);
    expect(second.exitCode).toBe(0);
  });

  it('rolls back the DB finish claim when the durable completion event cannot be written', async () => {
    await testDb.db.insert(schema.jobs).values({
      id: 'db-guard-job-event-rollback', project: 'guard-proj', kind: 'push',
      prompt: null, pid: 1, logPath: null,
      startedAt: Date.now() / 1000 - 5,
      finishedAt: null,
      exitCode: null,
      seen: false, durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
    } as any);

    await testDb.db.execute(sql.raw('DROP TABLE job_completion_events'));
    try {
      const job = makeJob('db-guard-job-event-rollback');
      await expect(markDoneFn(job, 0)).rejects.toThrow();
      expect(job.finishedAt).toBeNull();
      expect(job.exitCode).toBe(0);

      const row = (await testDb.db.select().from(schema.jobs))
        .find(r => r.id === 'db-guard-job-event-rollback');
      expect(row?.finishedAt).toBeNull();
      expect(row?.exitCode).toBeNull();
    } finally {
      await testDb.db.execute(sql.raw(`
        CREATE TABLE IF NOT EXISTS job_completion_events (
          id serial PRIMARY KEY,
          job_id text NOT NULL UNIQUE,
          kind text NOT NULL,
          exit_code integer,
          project text NOT NULL,
          release_id text,
          gh_issue_number integer,
          emitted_at double precision NOT NULL,
          consumed_by text,
          consumed_at double precision
        )
      `));
    }
  });

  it('proceeds normally when no DB row exists (new job not yet persisted)', async () => {
    // Job exists only in memory (no DB row inserted yet)
    const job = makeJob('db-guard-no-row');
    await markDoneFn(job, 0);

    // Should have finalized as normal
    expect(job.finishedAt).not.toBeNull();
    expect(job.exitCode).toBe(0);
    const events = await testDb.db.select().from(schema.jobCompletionEvents);
    expect(events.find(e => e.jobId === 'db-guard-no-row')).toMatchObject({
      jobId: 'db-guard-no-row',
      exitCode: 0,
    });
  });

  it('in-memory guard still fires before the DB check (finishedAt already set)', async () => {
    const job = makeJob('db-guard-inmem');
    job.finishedAt = Date.now() / 1000 - 5; // already finalized in memory

    const snapshotFinishedAt = job.finishedAt;
    await markDoneFn(job, 99);

    // In-memory guard should have returned before any DB interaction
    expect(job.finishedAt).toBe(snapshotFinishedAt); // unchanged
    expect(job.exitCode).toBeNull(); // not overwritten
  });
});
