import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

describe('startInProcessAgentJob', () => {
  let tempDir: string;
  let jobsCache: Map<string, JobData>;
  let saveToDb: ReturnType<typeof vi.fn>;
  let savedPids: number[];
  let markDone: ReturnType<typeof vi.fn>;
  let runSubprocess: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-inline-agent-'));
    savedPids = [];
    saveToDb = vi.fn((job: JobData) => {
      savedPids.push(job.pid);
    });
    markDone = vi.fn();
    runSubprocess = vi.fn(async (params: { onSpawn?: (pid: number) => void }) => {
      params.onSpawn?.(2468);
      return { pid: 2468, exitCode: 0, signal: null };
    });
    jobsCache = new Map<string, JobData>([
      ['job-1', {
        id: 'job-1',
        project: 'project',
        kind: 'agent:reviewer',
        prompt: null,
        pid: 0,
        logPath: null,
        startedAt: Date.now() / 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
      }],
    ]);

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: tempDir }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      jobsCache,
      saveToDb,
      markDone,
    }));
    vi.doMock('@/lib/jobs/cancellation', () => ({
      registerJobCancellation: vi.fn(() => new AbortController().signal),
      finishJobCancellation: vi.fn(),
    }));
    vi.doMock('@/lib/jobs/spawn-cli', () => ({ runSubprocess }));
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists the real child pid while the inline agent is running', async () => {
    const { startInProcessAgentJob } = await import('@/lib/jobs/inline-agent');

    const pid = await startInProcessAgentJob('job-1', 'agent-cli --flag', 'prompt', tempDir);
    const job = jobsCache.get('job-1');

    expect(pid).toBe(2468);
    expect(job?.pid).toBe(2468);
    expect(savedPids).toContain(process.pid);
    expect(savedPids).toContain(2468);
    expect(markDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1', pid: 2468 }), 0);
  });
});
