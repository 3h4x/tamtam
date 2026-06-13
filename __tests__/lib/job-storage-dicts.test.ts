import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import type { JobData } from '@/lib/jobs/job-storage';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

describe('job-storage response dictionaries', () => {
  let tempDir: string;
  let storageCache: Map<string, JobData>;
  let jobToDict: typeof import('@/lib/jobs/job-storage').jobToDict;
  let jobToListDict: typeof import('@/lib/jobs/job-storage').jobToListDict;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({
      db: sharedHandle.db,
      schema,
    }));
    const jobStorage = await import('@/lib/jobs/job-storage');
    jobToDict = jobStorage.jobToDict;
    jobToListDict = jobStorage.jobToListDict;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-job-dict-test-'));
    storageCache.clear();
    await truncateAll();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.resetModules();
  });

  describe('jobToDict', () => {
    it('converts running job to dict', () => {
      const job: JobData = {
        id: 'job-123',
        project: 'proj-a',
        kind: 'review',
        prompt: null,
        pid: 5678,
        logPath: '/path/to/log',
        startedAt: 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
        runScore: 91,
      };

      const dict = jobToDict(job);
      expect(dict).toMatchObject({
        id: 'job-123',
        project: 'proj-a',
        kind: 'review',
        prompt: null,
        pid: 5678,
        log_path: '/path/to/log',
        status: 'running',
        exit_code: null,
        started_at: 1000,
        finished_at: null,
        seen: false,
      });
      expect(dict).toHaveProperty('duration_ms');
      expect(dict).toHaveProperty('input_tokens');
      expect(dict).toHaveProperty('session_id');
      expect(dict.run_score).toBe(91);
    });

    it('converts finished job to dict', () => {
      const job: JobData = {
        id: 'job-456',
        project: 'proj-b',
        kind: 'test',
        prompt: null,
        pid: 9999,
        logPath: '/path/to/log2',
        startedAt: 1000,
        finishedAt: 2000,
        exitCode: 0,
        seen: true,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      const dict = jobToDict(job);
      expect(dict.status).toBe('done');
      expect(dict.exit_code).toBe(0);
      expect(dict.finished_at).toBe(2000);
      expect(dict.seen).toBe(true);
    });

    it('includes verdict in dict if present', () => {
      const logFile = join(tempDir, 'verdict.log');
      writeFileSync(logFile, 'Verdict: LGTM');

      const job: JobData = {
        id: 'job-789',
        project: 'proj-c',
        kind: 'review',
        prompt: null,
        pid: 1111,
        logPath: logFile,
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

      const dict = jobToDict(job);
      expect(dict.verdict).toBe('LGTM');
    });

    it('does not include plain-text failure detail in the full dict', () => {
      const logFile = join(tempDir, 'plain-failure.log');
      writeFileSync(logFile, 'fatal: auth expired\n');
      const job: JobData = {
        id: 'job-plain-failure',
        project: 'proj-c',
        kind: 'run',
        prompt: null,
        pid: 1111,
        logPath: logFile,
        startedAt: 1000,
        finishedAt: 2000,
        exitCode: 1,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      const dict = jobToDict(job);

      expect(dict).not.toHaveProperty('detail');
    });
  });

  describe('jobToListDict', () => {
    it('omits log path and truncates prompt payloads for list responses', () => {
      const prompt = 'p'.repeat(250);
      const userPrompt = 'u'.repeat(250);
      const job: JobData = {
        id: 'job-list',
        project: 'proj-list',
        kind: 'run',
        prompt,
        pid: 1234,
        logPath: '/path/to/large.log',
        startedAt: 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
        userPrompt,
      };

      const dict = jobToListDict(job);

      expect(dict.id).toBe('job-list');
      expect(dict).not.toHaveProperty('log_path');
      expect(dict.prompt).toHaveLength(200);
      expect(dict.user_prompt).toHaveLength(200);
    });

    it('preserves null prompt fields for list responses', () => {
      const job: JobData = {
        id: 'job-list-null',
        project: 'proj-list',
        kind: 'run',
        prompt: null,
        pid: 1234,
        logPath: null,
        startedAt: 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
        userPrompt: null,
      };

      const dict = jobToListDict(job);

      expect(dict.prompt).toBeNull();
      expect(dict.user_prompt).toBeNull();
    });

    it('includes compact failure detail for failed list rows', () => {
      const logFile = join(tempDir, 'list-plain-failure.log');
      writeFileSync(logFile, 'fatal: auth expired\n');
      const job: JobData = {
        id: 'job-list-failure',
        project: 'proj-list',
        kind: 'run',
        prompt: null,
        pid: 1234,
        logPath: logFile,
        startedAt: 1000,
        finishedAt: 2000,
        exitCode: 1,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      const dict = jobToListDict(job);

      expect(dict.detail).toBe('fatal: auth expired');
      expect(dict).not.toHaveProperty('log_path');
    });

    it('caps list failure detail extracted from log tails', () => {
      const logFile = join(tempDir, 'list-long-failure.log');
      writeFileSync(logFile, `${'x'.repeat(2500)}\n`);
      const job: JobData = {
        id: 'job-list-long-failure',
        project: 'proj-list',
        kind: 'run',
        prompt: null,
        pid: 1234,
        logPath: logFile,
        startedAt: 1000,
        finishedAt: 2000,
        exitCode: 1,
        seen: false,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        sessionId: null,
      };

      const dict = jobToListDict(job);

      expect(typeof dict.detail).toBe('string');
      expect((dict.detail as string).length).toBe(2000);
      expect(dict.detail).toMatch(/…$/);
    });
  });

});
