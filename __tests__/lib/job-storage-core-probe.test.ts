import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import type { JobData } from '@/lib/jobs/job-storage';
import {
  applyJobStorageDdl,
  createTestPgDbEmpty,
  drainJobStorageDb,
  truncateJobStorageTables,
  type TestDbHandle,
} from './job-storage-core-fixtures';

let sharedHandle: TestDbHandle;

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyJobStorageDdl(sharedHandle);
});

afterAll(async () => {
  await drainJobStorageDb(sharedHandle);
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

async function truncateAll(): Promise<void> {
  await truncateJobStorageTables(sharedHandle);
}

describe('job-storage core probe', () => {
  let storageCache: Map<string, JobData>;
  let probeJobStatus: typeof import('@/lib/jobs/job-storage').probeJobStatus;
  const resolveProjectPathMock = vi.fn();

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({
      db: sharedHandle.db,
      schema,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    const jobStorage = await import('@/lib/jobs/job-storage');
    probeJobStatus = jobStorage.probeJobStatus;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
  });

  beforeEach(async () => {
    storageCache.clear();
    resolveProjectPathMock.mockReset().mockReturnValue(null);
    await truncateAll();
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/project-data');
    vi.resetModules();
  });

  describe('probeJobStatus', () => {
    it('returns done if job has finishedAt', async () => {
      const job: JobData = {
        id: 'job-done',
        project: 'proj',
        kind: 'run',
        prompt: null,
        pid: 123,
        logPath: null,
        startedAt: 1000,
        finishedAt: 2000,
        exitCode: 0,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      const status = await probeJobStatus(job);
      expect(status).toBe('done');
    });

    it('marks job as done if pid no longer exists', async () => {
      const missingProcess = new Error('ESRCH') as NodeJS.ErrnoException;
      missingProcess.code = 'ESRCH';
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw missingProcess;
      });
      const job: JobData = {
        id: 'job-bad-pid',
        project: 'proj',
        kind: 'run',
        prompt: null,
        pid: 99999,
        logPath: null,
        startedAt: Date.now() / 1000 - 60,
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

      try {
        const status = await probeJobStatus(job);
        expect(status).toBe('done');
        expect(job.finishedAt).not.toBeNull();
        expect(job.exitCode).toBe(-1);
      } finally {
        killSpy.mockRestore();
      }
    });

  });
});
