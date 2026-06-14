import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import { getSharedHandle, makeMissingProcessError } from './job-storage-probe-fixtures';

describe('probeJobStatus – test/action kind liveness via process.kill', () => {
  let probeJobStatusFn: typeof import('@/lib/jobs/job-storage').probeJobStatus;
  let storageCache: Map<string, JobData>;
  let jobSeq = 0;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: getSharedHandle().db, schema }));
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
