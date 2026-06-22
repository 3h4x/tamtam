import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import {
  flushDbQueue,
  testDb,
  truncateAll,
  sharedHandle,
} from './job-storage-pipeline-fixtures';

describe('persistVerdict', () => {
  let createJobFn: typeof import('@/lib/jobs/job-storage').createJob;
  let getJobFn: typeof import('@/lib/jobs/job-storage').getJob;
  let persistVerdictFn: typeof import('@/lib/jobs/job-storage').persistVerdict;
  let awaitInFlightSaveFn: typeof import('@/lib/jobs/storage').awaitInFlightSave;
  let storageCache: Map<string, JobData>;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/jobs/job-storage');
    createJobFn = mod.createJob;
    getJobFn = mod.getJob;
    persistVerdictFn = mod.persistVerdict;
    const storage = await import('@/lib/jobs/storage');
    awaitInFlightSaveFn = storage.awaitInFlightSave;
    storageCache = storage.jobsCache;
  });

  beforeEach(async () => {
    storageCache.clear();
    await truncateAll();
  });

  afterAll(() => {
    vi.doUnmock('@/lib/db');
    vi.resetModules();
  });

  it('writes verdict to DB and in-memory cache', async () => {
    const job = createJobFn('proj', 'review', 1, '/log');
    persistVerdictFn(job.id, 'LGTM');

    await awaitInFlightSaveFn(job.id);
    await flushDbQueue();

    const rows = await testDb.db.select().from(schema.jobs);
    const stored = rows.find((r) => r.id === job.id);
    expect(stored?.verdict).toBe('LGTM');

    const cached = getJobFn(job.id);
    expect(cached?.verdict).toBe('LGTM');
  });

  it('updates an existing verdict', async () => {
    const job = createJobFn('proj', 'review', 2, '/log');
    persistVerdictFn(job.id, 'NEEDS ATTENTION');
    persistVerdictFn(job.id, 'DO NOT SHIP');

    await awaitInFlightSaveFn(job.id);
    await flushDbQueue();

    const rows = await testDb.db.select().from(schema.jobs);
    const stored = rows.find((r) => r.id === job.id);
    expect(stored?.verdict).toBe('DO NOT SHIP');

    expect(getJobFn(job.id)?.verdict).toBe('DO NOT SHIP');
  });

  it('silently no-ops for an unknown jobId (no throw)', () => {
    expect(() => persistVerdictFn('nonexistent-job', 'LGTM')).not.toThrow();
  });
});
