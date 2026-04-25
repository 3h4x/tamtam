import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeExecResult(exitCode: number, stdout = '', stderr = '') {
  return { exitCode, stdout, stderr };
}

describe('pm2-jobs', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let logDir: string;
  let startJob: typeof import('@/lib/pm2-jobs').startJob;
  let getJobStatus: typeof import('@/lib/pm2-jobs').getJobStatus;
  let deleteJob: typeof import('@/lib/pm2-jobs').deleteJob;
  let getJobPid: typeof import('@/lib/pm2-jobs').getJobPid;

  beforeEach(async () => {
    vi.resetModules();
    logDir = mkdtempSync(join(tmpdir(), 'tamtam-pm2-jobs-'));
    execMock = vi.fn();

    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ logDir }),
    }));

    const mod = await import('@/lib/pm2-jobs');
    startJob = mod.startJob;
    getJobStatus = mod.getJobStatus;
    deleteJob = mod.deleteJob;
    getJobPid = mod.getJobPid;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(logDir, { recursive: true, force: true });
  });

  describe('startJob', () => {
    it('creates prompt and script files in the log dir', async () => {
      execMock.mockResolvedValue(makeExecResult(0, '[]'));

      await startJob('job-123', 'claude --output-format stream-json', 'hello world', '/projects/foo');

      const promptPath = join(logDir, 'job-123.prompt');
      const scriptPath = join(logDir, 'job-123.sh');
      expect(existsSync(promptPath)).toBe(true);
      expect(existsSync(scriptPath)).toBe(true);
      expect(readFileSync(promptPath, 'utf-8')).toBe('hello world');
    });

    it('script contains the command and prompt path', async () => {
      execMock.mockResolvedValue(makeExecResult(0, '[]'));

      await startJob('job-abc', 'claude --model opus', 'prompt text', '/projects/bar');

      const scriptPath = join(logDir, 'job-abc.sh');
      const script = readFileSync(scriptPath, 'utf-8');
      expect(script).toContain('#!/bin/bash');
      expect(script).toContain('claude --model opus');
      expect(script).toContain('job-abc.prompt');
    });

    it('calls pm2 start with correct args', async () => {
      execMock.mockResolvedValue(makeExecResult(0, '[]'));

      await startJob('job-xyz', 'claude', 'p', '/cwd');

      const pm2Call = execMock.mock.calls.find(
        (c: unknown[]) => c[0] === 'pm2' && Array.isArray(c[1]) && c[1][0] === 'start'
      );
      expect(pm2Call).toBeDefined();
      const args = pm2Call![1] as string[];
      expect(args).toContain('--name');
      expect(args).toContain('job-xyz');
      expect(args).toContain('--no-autorestart');
      expect(args).toContain('--cwd');
      expect(args).toContain('/cwd');
    });

    it('throws when pm2 start fails', async () => {
      execMock.mockResolvedValue(makeExecResult(1, '', 'pm2 error'));

      await expect(startJob('job-fail', 'claude', 'p', '/cwd')).rejects.toThrow(
        'pm2 start failed: pm2 error'
      );
    });

    it('returns pid from pm2 jlist after start', async () => {
      const jlistOutput = JSON.stringify([{ name: 'job-pid', pid: 42, pm2_env: { status: 'online' } }]);
      execMock
        .mockResolvedValueOnce(makeExecResult(0)) // pm2 start
        .mockResolvedValueOnce(makeExecResult(0, jlistOutput)); // pm2 jlist for getPm2Pid

      const pid = await startJob('job-pid', 'claude', 'p', '/cwd');
      expect(pid).toBe(42);
    });

    it('returns 0 when pm2 jlist returns empty list', async () => {
      execMock
        .mockResolvedValueOnce(makeExecResult(0)) // pm2 start
        .mockResolvedValueOnce(makeExecResult(0, '[]')); // pm2 jlist

      const pid = await startJob('job-nopid', 'claude', 'p', '/cwd');
      expect(pid).toBe(0);
    });

    it('escapes double quotes in command within script', async () => {
      execMock.mockResolvedValue(makeExecResult(0, '[]'));

      await startJob('job-esc', 'claude --param "value"', 'p', '/cwd');

      const scriptPath = join(logDir, 'job-esc.sh');
      const script = readFileSync(scriptPath, 'utf-8');
      // The echo line should have escaped quotes
      expect(script).toContain('\\"value\\"');
    });
  });

  describe('getJobStatus', () => {
    it('returns unknown when pm2 jlist fails', async () => {
      execMock.mockResolvedValue(makeExecResult(1, '', 'error'));

      const result = await getJobStatus('job-1');
      expect(result).toEqual({ status: 'unknown', exitCode: null });
    });

    it('returns unknown when job is not in pm2 list', async () => {
      execMock.mockResolvedValue(makeExecResult(0, JSON.stringify([{ name: 'other-job' }])));

      const result = await getJobStatus('job-missing');
      expect(result).toEqual({ status: 'unknown', exitCode: null });
    });

    it('returns running when pm2 status is online', async () => {
      const jlist = JSON.stringify([{ name: 'job-1', pm2_env: { status: 'online', exit_code: 0 } }]);
      execMock.mockResolvedValue(makeExecResult(0, jlist));

      const result = await getJobStatus('job-1');
      expect(result).toEqual({ status: 'running', exitCode: null });
    });

    it('returns done with exit code when pm2 status is stopped', async () => {
      const jlist = JSON.stringify([{ name: 'job-1', pm2_env: { status: 'stopped', exit_code: 0 } }]);
      execMock.mockResolvedValue(makeExecResult(0, jlist));

      const result = await getJobStatus('job-1');
      expect(result).toEqual({ status: 'done', exitCode: 0 });
    });

    it('returns done with exit code when pm2 status is errored', async () => {
      const jlist = JSON.stringify([{ name: 'job-1', pm2_env: { status: 'errored', exit_code: 1 } }]);
      execMock.mockResolvedValue(makeExecResult(0, jlist));

      const result = await getJobStatus('job-1');
      expect(result).toEqual({ status: 'done', exitCode: 1 });
    });

    it('returns done with -1 when exit_code is missing and status is stopped', async () => {
      const jlist = JSON.stringify([{ name: 'job-1', pm2_env: { status: 'stopped' } }]);
      execMock.mockResolvedValue(makeExecResult(0, jlist));

      const result = await getJobStatus('job-1');
      expect(result).toEqual({ status: 'done', exitCode: -1 });
    });

    it('returns done with -1 for unrecognized pm2 status', async () => {
      const jlist = JSON.stringify([{ name: 'job-1', pm2_env: { status: 'launching' } }]);
      execMock.mockResolvedValue(makeExecResult(0, jlist));

      const result = await getJobStatus('job-1');
      expect(result).toEqual({ status: 'done', exitCode: -1 });
    });

    it('returns unknown when jlist throws a parse error', async () => {
      execMock.mockResolvedValue(makeExecResult(0, 'not-valid-json'));

      const result = await getJobStatus('job-1');
      expect(result).toEqual({ status: 'unknown', exitCode: null });
    });
  });

  describe('deleteJob', () => {
    it('calls pm2 delete with the job id', async () => {
      execMock.mockResolvedValue(makeExecResult(0));

      await deleteJob('job-del');

      expect(execMock).toHaveBeenCalledWith('pm2', ['delete', 'job-del'], { timeout: 10000 });
    });
  });

  describe('getJobPid', () => {
    it('returns pid when job is in pm2 list', async () => {
      const jlist = JSON.stringify([{ name: 'job-1', pid: 99, pm2_env: { status: 'online' } }]);
      execMock.mockResolvedValue(makeExecResult(0, jlist));

      const pid = await getJobPid('job-1');
      expect(pid).toBe(99);
    });

    it('returns null when job is not in pm2 list', async () => {
      execMock.mockResolvedValue(makeExecResult(0, '[]'));

      const pid = await getJobPid('job-missing');
      expect(pid).toBeNull();
    });

    it('returns null when pm2 jlist fails', async () => {
      execMock.mockResolvedValue(makeExecResult(1, '', 'error'));

      const pid = await getJobPid('job-err');
      expect(pid).toBeNull();
    });
  });
});
