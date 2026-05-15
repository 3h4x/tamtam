import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobData } from '@/lib/jobs/types';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'test-job-1',
    project: 'myproj',
    kind: 'review',
    prompt: null,
    pid: 1234,
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
    userPrompt: null,
    contextMeta: null,
    parentJobId: null,
    ghIssueNumber: null,
    ghIssueRepo: null,
    ghIssueTitle: null,
    logPruned: false,
    costUsd: null,
    model: null,
    releaseId: null,
    abortedAt: null,
    ...overrides,
  };
}

describe('probeJobStatus', () => {
  let tempDir: string;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let reconcileMock: ReturnType<typeof vi.fn>;
  let getJobStatusMock: ReturnType<typeof vi.fn>;
  let getJobPidMock: ReturnType<typeof vi.fn>;
  let saveToDbMock: ReturnType<typeof vi.fn>;
  let getJobCancellationSignalMock: ReturnType<typeof vi.fn>;
  let probeJobStatus: typeof import('@/lib/jobs/probe').probeJobStatus;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-probe-test-'));

    markDoneMock = vi.fn().mockResolvedValue(undefined);
    reconcileMock = vi.fn().mockResolvedValue(undefined);
    getJobStatusMock = vi.fn().mockResolvedValue({ status: 'running', exitCode: null });
    getJobPidMock = vi.fn().mockResolvedValue(null);
    saveToDbMock = vi.fn();
    getJobCancellationSignalMock = vi.fn().mockReturnValue(null);

    vi.doMock('@/lib/jobs/cancellation', () => ({
      getJobCancellationSignal: getJobCancellationSignalMock,
    }));
    vi.doMock('@/lib/jobs/lifecycle', () => ({
      markDone: markDoneMock,
      reconcileStaleRelease: reconcileMock,
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      getJobStatus: getJobStatusMock,
      getJobPid: getJobPidMock,
    }));
    vi.doMock('@/lib/jobs/storage', () => ({
      saveToDb: saveToDbMock,
    }));

    const mod = await import('@/lib/jobs/probe');
    probeJobStatus = mod.probeJobStatus;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('already finished jobs', () => {
    it('returns done immediately when finishedAt is set', async () => {
      const job = makeJob({ finishedAt: Date.now() / 1000 - 10 });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(reconcileMock).toHaveBeenCalledWith(job);
      expect(markDoneMock).not.toHaveBeenCalled();
    });
  });

  describe('push/commit inline kinds', () => {
    it('push with same pid as process → running', async () => {
      const job = makeJob({ kind: 'push', pid: process.pid });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
      expect(markDoneMock).not.toHaveBeenCalled();
    });

    it('push with different pid → marks done and returns done', async () => {
      const job = makeJob({ kind: 'push', pid: 99999 });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, -1);
    });

    it('commit with same pid → running', async () => {
      const job = makeJob({ kind: 'commit', pid: process.pid });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
    });

    it('commit with different pid → marks done', async () => {
      const job = makeJob({ kind: 'commit', pid: 77777 });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, -1);
    });
  });

  describe('pid=0 (spawn grace window)', () => {
    it('pid=0, age < 30s → still spawning, running', async () => {
      const job = makeJob({ pid: 0, startedAt: Date.now() / 1000 - 5 });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
      expect(markDoneMock).not.toHaveBeenCalled();
    });

    it('pid=0, age >= 30s, mark-dod → inline kind, running', async () => {
      const job = makeJob({ kind: 'mark-dod', pid: 0, startedAt: Date.now() / 1000 - 60 });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
    });

    it('pid=0, age >= 30s, pr-wait → inline kind, running', async () => {
      const job = makeJob({ kind: 'pr-wait', pid: 0, startedAt: Date.now() / 1000 - 60 });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
    });

    it('pid=0, age >= 30s, test → marks done -1', async () => {
      const job = makeJob({ kind: 'test', pid: 0, startedAt: Date.now() / 1000 - 60 });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, -1);
    });

    it('pid=0, age >= 30s, action → marks done -1', async () => {
      const job = makeJob({ kind: 'action', pid: 0, startedAt: Date.now() / 1000 - 60 });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, -1);
    });

    // Per-job PM2 entries were retired; the PM2-status backfill paths these
    // tests covered (pm2 jlist → pid backfill, pm2 reports done with exit
    // code) no longer exist. The replacement behavior — pid=0 past grace +
    // no inline cancellation signal → markDone(-1) — is asserted below in
    // "pid=0, age >= 30s, PM2 unknown → marks done -1".

    it('pid=0, age >= 30s, PM2 unknown → marks done -1', async () => {
      getJobStatusMock.mockResolvedValue({ status: 'unknown', exitCode: null });
      const job = makeJob({ kind: 'run', pid: 0, startedAt: Date.now() / 1000 - 60 });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, -1);
    });

    it('pid=0, age >= 30s, PM2 unknown but route holds inline cancellation signal → still running', async () => {
      getJobStatusMock.mockResolvedValue({ status: 'unknown', exitCode: null });
      getJobCancellationSignalMock.mockReturnValue({ aborted: false } as AbortSignal);
      const job = makeJob({ kind: 'agent:my-agent', pid: 0, startedAt: Date.now() / 1000 - 60 });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
      expect(markDoneMock).not.toHaveBeenCalled();
    });

    it('pid=0, age >= 30s, PM2 unknown and inline signal already aborted → marks done -1', async () => {
      getJobStatusMock.mockResolvedValue({ status: 'unknown', exitCode: null });
      getJobCancellationSignalMock.mockReturnValue({ aborted: true } as AbortSignal);
      const job = makeJob({ kind: 'agent:my-agent', pid: 0, startedAt: Date.now() / 1000 - 60 });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, -1);
    });
  });

  describe('pid > 0 — claude kinds with result line', () => {
    it('claude kind with is_error:false result line → marks done 0', async () => {
      const logPath = join(tempDir, 'job1.log');
      writeFileSync(logPath, `{"type":"result","is_error":false}\n`);
      const job = makeJob({ kind: 'run', pid: 1234, logPath });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, 0);
    });

    it('claude kind with is_error:true result line → marks done 1', async () => {
      const logPath = join(tempDir, 'job2.log');
      writeFileSync(logPath, `{"type":"result","is_error":true}\n`);
      const job = makeJob({ kind: 'review', pid: 1234, logPath });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, 1);
    });

    it('agent kind with result line → marks done', async () => {
      const logPath = join(tempDir, 'job3.log');
      writeFileSync(logPath, `{"type":"result","is_error":false}\n`);
      const job = makeJob({ kind: 'agent:tests', pid: 1234, logPath });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, 0);
    });

    it('claude kind with timestamp-prefixed result line → parses correctly', async () => {
      const logPath = join(tempDir, 'job4.log');
      writeFileSync(logPath, `2024-01-15T10:00:00Z: {"type":"result","is_error":false}\n`);
      const job = makeJob({ kind: 'fix', pid: 1234, logPath });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, 0);
    });

    it("claude kind with malformed result line → treats parse failure as success", async () => {
      const logPath = join(tempDir, 'job4b.log');
      writeFileSync(logPath, `{"type":"result","is_error":false\n`);
      const job = makeJob({ kind: 'fix', pid: 1234, logPath });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, 0);
    });

    it('claude kind without result line → falls through to pid liveness check', async () => {
      const logPath = join(tempDir, 'job5.log');
      writeFileSync(logPath, `{"type":"text","content":"thinking..."}\n`);
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as unknown as ReturnType<typeof process.kill>);
      const job = makeJob({ kind: 'run', pid: 1234, logPath });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
      expect(markDoneMock).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });

    it('claude kind with no log file → falls through to pid liveness check', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as unknown as ReturnType<typeof process.kill>);
      const job = makeJob({ kind: 'fix-ci', pid: 1234, logPath: null });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
      killSpy.mockRestore();
    });
  });

  describe('pid > 0 — test/action kinds', () => {
    it('test, process alive → running', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as unknown as ReturnType<typeof process.kill>);
      const job = makeJob({ kind: 'test', pid: 1234, logPath: null });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
      expect(killSpy).toHaveBeenCalledWith(1234, 0);
      killSpy.mockRestore();
    });

    it('test, process dead (ESRCH) → marks done -1', async () => {
      const err = Object.assign(new Error('no such process'), { code: 'ESRCH' });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw err; });
      const job = makeJob({ kind: 'test', pid: 1234, logPath: null });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, -1);
      killSpy.mockRestore();
    });

    it('test, EPERM → process exists, running', async () => {
      const err = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw err; });
      const job = makeJob({ kind: 'test', pid: 1234, logPath: null });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
      killSpy.mockRestore();
    });

    it('action, process dead → marks done -1', async () => {
      const err = Object.assign(new Error('no such process'), { code: 'ESRCH' });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw err; });
      const job = makeJob({ kind: 'action', pid: 1234, logPath: null });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, -1);
      killSpy.mockRestore();
    });
  });

  describe('pid > 0 — generic kinds via process.kill', () => {
    it('process alive → running', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as unknown as ReturnType<typeof process.kill>);
      const job = makeJob({ kind: 'review', pid: 1234, logPath: null });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
      expect(markDoneMock).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });

    // Legacy PM2 status-check test removed (path no longer exists).
    it.skip('PM2 done with exit 0 → marks done 0', async () => {
      getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });
      const job = makeJob({ kind: 'review', pid: 1234, logPath: null });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, 0);
    });

    it('PM2 done with null exit → uses -1 fallback', async () => {
      getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: null });
      const job = makeJob({ kind: 'fix', pid: 1234, logPath: null });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, -1);
    });

    it('PM2 unknown, process alive → running', async () => {
      getJobStatusMock.mockResolvedValue({ status: 'unknown', exitCode: null });
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as unknown as ReturnType<typeof process.kill>);
      const job = makeJob({ kind: 'review', pid: 1234, logPath: null });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
      killSpy.mockRestore();
    });

    it('PM2 unknown, process dead → marks done -1', async () => {
      getJobStatusMock.mockResolvedValue({ status: 'unknown', exitCode: null });
      const err = Object.assign(new Error('no such process'), { code: 'ESRCH' });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw err; });
      const job = makeJob({ kind: 'review', pid: 1234, logPath: null });
      const result = await probeJobStatus(job);
      expect(result).toBe('done');
      expect(markDoneMock).toHaveBeenCalledWith(job, -1);
      killSpy.mockRestore();
    });

    it('PM2 unknown, EPERM → running', async () => {
      getJobStatusMock.mockResolvedValue({ status: 'unknown', exitCode: null });
      const err = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw err; });
      const job = makeJob({ kind: 'run', pid: 1234, logPath: null });
      const result = await probeJobStatus(job);
      expect(result).toBe('running');
      killSpy.mockRestore();
    });
  });
});
