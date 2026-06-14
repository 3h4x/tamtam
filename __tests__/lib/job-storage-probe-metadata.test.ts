import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getSharedHandle, testDb, truncateAll } from './job-storage-probe-fixtures';

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
    vi.doMock('@/lib/db', () => ({ db: getSharedHandle().db, schema }));
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
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: vi.fn().mockResolvedValue({ ok: false }),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: vi.fn().mockResolvedValue({ ok: false }),
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
    await truncateAll();
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
    vi.doUnmock('@/lib/pipeline/start-commit');
    vi.doUnmock('@/lib/pipeline/start-fix');
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
    expect(job.model).toBeUndefined();
    expect(job.costUsd).toBeUndefined();
  });

  it('DOES populate sessionId/tokens for non-release kinds', async () => {
    const logFile = join(tempDir, 'review.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('run', logFile);

    await markDoneFn(job, 0);

    expect(job.sessionId).toBe('ses-abc');
    expect(job.inputTokens).toBe(100);
    expect(job.outputTokens).toBe(50);
    expect(job.cacheReadTokens).toBe(10);
    expect(job.cacheCreateTokens).toBe(5);
    expect(job.durationMs).toBe(1234);
  });

  it('DOES populate metadata for another non-release job', async () => {
    const logFile = join(tempDir, 'commit.log');
    writeFileSync(logFile, resultLine + '\n');
    const job = makeJob('run', logFile);

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

});
