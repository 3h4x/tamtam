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

  it('retries once with the fallback provider after a transient failure', async () => {
    runSubprocess
      .mockImplementationOnce(async (params: { onSpawn?: (pid: number) => void }) => {
        params.onSpawn?.(1111);
        return { pid: 1111, exitCode: 1, signal: null, outputTail: 'HTTP 503 service unavailable' };
      })
      .mockImplementationOnce(async (params: { onSpawn?: (pid: number) => void }) => {
        params.onSpawn?.(2222);
        return { pid: 2222, exitCode: 0, signal: null, outputTail: 'ok' };
      });
    const { startInProcessAgentJob } = await import('@/lib/jobs/inline-agent');

    const pid = await startInProcessAgentJob('job-1', 'codex-cli --flag', 'prompt', tempDir, {
      fallback: {
        provider: 'claude',
        command: 'claude-cli --flag',
      },
    });

    expect(pid).toBe(2222);
    expect(runSubprocess).toHaveBeenCalledTimes(2);
    expect(runSubprocess.mock.calls[0][0]).toMatchObject({ cmd: 'codex-cli' });
    expect(runSubprocess.mock.calls[1][0]).toMatchObject({ cmd: 'claude-cli' });
    expect(jobsCache.get('job-1')?.provider).toBe('claude');
    expect(markDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), 0);
  });

  it('does not retry more than once when the fallback also fails', async () => {
    runSubprocess
      .mockResolvedValueOnce({ pid: 1111, exitCode: 1, signal: null, outputTail: 'rate limit exceeded' })
      .mockResolvedValueOnce({ pid: 2222, exitCode: 1, signal: null, outputTail: 'HTTP 503 service unavailable' });
    const { startInProcessAgentJob } = await import('@/lib/jobs/inline-agent');

    await startInProcessAgentJob('job-1', 'codex-cli --flag', 'prompt', tempDir, {
      fallback: {
        provider: 'claude',
        command: 'claude-cli --flag',
      },
    });

    expect(runSubprocess).toHaveBeenCalledTimes(2);
    expect(markDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), 1);
  });
});
