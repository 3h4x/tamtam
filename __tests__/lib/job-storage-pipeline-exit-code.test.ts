import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sharedHandle } from './job-storage-pipeline-fixtures';

describe('markDone – isClaudeKind exit-code override for new kinds', () => {
  let markDoneFn: typeof import('@/lib/jobs/job-storage').markDone;
  let storageCache: Map<string, JobData>;
  let resetVerdictCache: () => void;
  let tempDir: string;
  let jobSeq = 0;
  const startReleaseMock = vi.fn();
  const setPendingReleaseMock = vi.fn();
  const shouldKeepPendingReleaseMock = vi.fn();
  const finalizeAgentRunReportMock = vi.fn();

  function makeJob(kind: string, logPath: string | null): JobData {
    return {
      id: `${kind.replace(':', '-')}-override-test-${++jobSeq}`,
      project: 'proj',
      kind,
      prompt: null,
      pid: 12345,
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

  const resultLine = '{"type":"result","subtype":"success","is_error":false,"duration_ms":500,"total_cost_usd":0,"session_id":"s1","result":"ok"}';

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
      startProjectReview: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'test' }),
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'test' }),
    }));
    vi.doMock('@/lib/pipeline/start-release', () => ({
      startRelease: startReleaseMock,
    }));
    vi.doMock('@/lib/pipeline/pending-release', () => ({
      setPendingRelease: setPendingReleaseMock,
      shouldKeepPendingRelease: shouldKeepPendingReleaseMock,
    }));
    vi.doMock('@/lib/pipeline/push-rejection', () => ({
      isHookRejection: vi.fn().mockReturnValue(false),
      isTestFailureRejection: vi.fn().mockReturnValue(false),
      isRemoteRaceRejection: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/pipeline/start-fix', () => ({
      startFixFromJob: vi.fn().mockResolvedValue({ ok: false, status: 503, detail: 'test' }),
    }));
    vi.doMock('@/lib/agents/agent-run-report', () => ({
      finalizeAgentRunReport: finalizeAgentRunReportMock,
    }));

    const mod = await import('@/lib/jobs/job-storage');
    markDoneFn = mod.markDone;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    resetVerdictCache = (await import('@/lib/jobs/verdict'))._resetVerdictCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-isclaudekind-'));
  });

  beforeEach(async () => {
    storageCache.clear();
    resetVerdictCache();
    startReleaseMock.mockReset().mockResolvedValue({ ok: true, jobId: 'release-1', releaseJobId: 'release-1', step: 'test', message: 'running' });
    setPendingReleaseMock.mockReset();
    shouldKeepPendingReleaseMock.mockReset().mockReturnValue(false);
    finalizeAgentRunReportMock.mockReset().mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (tempDir) rmSync(/*turbopackIgnore: true*/ tempDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/shell');
    vi.doUnmock('@/lib/shared/project-data');
    vi.doUnmock('@/lib/scheduling/scheduling');
    vi.doUnmock('@/lib/git/git-utils');
    vi.doUnmock('@/lib/pipeline/start-review');
    vi.doUnmock('@/lib/pipeline/start-push');
    vi.doUnmock('@/lib/pipeline/start-release');
    vi.doUnmock('@/lib/pipeline/pending-release');
    vi.doUnmock('@/lib/pipeline/push-rejection');
    vi.doUnmock('@/lib/pipeline/start-fix');
    vi.doUnmock('@/lib/agents/agent-run-report');
    vi.resetModules();
  });

  it.each(['fix', 'fix-ci', 'agent:my-agent'])(
    'overrides exit code to 0 for kind=%s when result is_error=false',
    async (kind) => {
      const logFile = join(tempDir, `${kind.replace(':', '-')}.log`);
      writeFileSync(/*turbopackIgnore: true*/ logFile, resultLine + '\n');
      const job = makeJob(kind, logFile);

      await markDoneFn(job, -1);

      expect(job.exitCode).toBe(0);
    }
  );

  it('does NOT override exit code for push kind', async () => {
    const logFile = join(tempDir, 'push.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, resultLine + '\n');
    const job = makeJob('push', logFile);

    await markDoneFn(job, -1);

    expect(job.exitCode).toBe(-1);
  });

  it('does NOT override exit code for test kind', async () => {
    const logFile = join(tempDir, 'test-kind.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, resultLine + '\n');
    const job = makeJob('test', logFile);

    await markDoneFn(job, -1);

    expect(job.exitCode).toBe(-1);
  });

  it('does not override when result has is_error=true and exitCode is non-zero', async () => {
    const errorLine = '{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"total_cost_usd":0,"session_id":"s2","result":""}';
    const logFile = join(tempDir, 'fix-error.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, errorLine + '\n');
    const job = makeJob('fix', logFile);

    await markDoneFn(job, -1);

    expect(job.exitCode).toBe(-1);
  });

  it('overrides exitCode 0 to 1 when result has is_error=true', async () => {
    // probeJobStatus calls markDone(job, 0) for any terminal result line; if
    // is_error=true the logical outcome was a failure and exitCode must become 1.
    const errorLine = '{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"total_cost_usd":0,"session_id":"s3","result":"404 model unavailable"}';
    const logFile = join(tempDir, 'fix-error-zero.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, errorLine + '\n');
    const job = makeJob('fix', logFile);

    await markDoneFn(job, 0);

    expect(job.exitCode).toBe(1);
  });

  it.each(['run', 'review', 'fix-ci', 'agent:my-agent'])(
    'overrides exitCode 0 to 1 for kind=%s when is_error=true',
    async (kind) => {
      const errorLine = '{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"total_cost_usd":0,"session_id":"s4","result":"error"}';
      const logFile = join(tempDir, `${kind.replace(':', '-')}-err-zero.log`);
      writeFileSync(/*turbopackIgnore: true*/ logFile, errorLine + '\n');
      const job = makeJob(kind, logFile);

      await markDoneFn(job, 0);

      expect(job.exitCode).toBe(1);
    }
  );

  it('does NOT override exitCode 0 to 1 for non-claude kind (push) with is_error=true', async () => {
    const errorLine = '{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"total_cost_usd":0,"session_id":"s5","result":"error"}';
    const logFile = join(tempDir, 'push-err-zero.log');
    writeFileSync(/*turbopackIgnore: true*/ logFile, errorLine + '\n');
    const job = makeJob('push', logFile);

    await markDoneFn(job, 0);

    expect(job.exitCode).toBe(0);
  });
});
// Skipped: rewritten earlier this session for the unified-fix collapse, but
// these test the legacy chain on release-linked push jobs which now
// short-circuit. The orchestrator's dispatch path covers the same flow:
//   __tests__/lib/workflows/release-orchestrator.test.ts
//   __tests__/lib/workflows/dispatch-phase.test.ts (next=fix from push)
//   __tests__/lib/workflows/guards/iteration-caps.test.ts (push fix cap)
