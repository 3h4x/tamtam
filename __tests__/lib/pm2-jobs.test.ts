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
    it('writes the prompt file (still consumed by /api/jobs/[id]/rerun) and does NOT write a .sh wrapper', async () => {
      execMock.mockResolvedValue(makeExecResult(0, '[]'));

      await startJob('job-123', 'claude --output-format stream-json', 'hello world', '/projects/foo');

      const promptPath = join(logDir, 'job-123.prompt');
      const scriptPath = join(logDir, 'job-123.sh');
      expect(existsSync(promptPath)).toBe(true);
      expect(readFileSync(promptPath, 'utf-8')).toBe('hello world');
      // The bash wrapper is gone — PM2 spawns scripts/job-runner.js directly.
      expect(existsSync(scriptPath)).toBe(false);
    });

    it('invokes pm2 with --interpreter node + the runner script + tokenized command argv', async () => {
      execMock.mockResolvedValue(makeExecResult(0, '[]'));

      await startJob('job-xyz', 'claude --model opus --print', 'p', '/cwd');

      const pm2Call = execMock.mock.calls.find(
        (c: unknown[]) => c[0] === 'pm2' && Array.isArray(c[1]) && c[1][0] === 'start'
      );
      expect(pm2Call).toBeDefined();
      const args = pm2Call![1] as string[];
      // First positional after `start` is the runner path.
      expect(args[1]).toMatch(/scripts\/job-runner\.js$/);
      expect(args).toContain('--interpreter');
      expect(args).toContain('node');
      expect(args).toContain('--name');
      expect(args).toContain('job-xyz');
      expect(args).toContain('--no-autorestart');
      expect(args).toContain('--cwd');
      expect(args).toContain('/cwd');
      // Runner argv after `--`: <jobId> <logPath> <promptPath> <cmd...>
      const dashDash = args.indexOf('--');
      expect(dashDash).toBeGreaterThan(0);
      const runnerArgv = args.slice(dashDash + 1);
      expect(runnerArgv[0]).toBe('job-xyz');
      expect(runnerArgv[1]).toMatch(/job-xyz\.log$/);
      expect(runnerArgv[2]).toMatch(/job-xyz\.prompt$/);
      expect(runnerArgv.slice(3)).toEqual(['claude', '--model', 'opus', '--print']);
    });

    it('throws when pm2 start fails', async () => {
      execMock.mockResolvedValue(makeExecResult(1, '', 'pm2 error'));

      await expect(startJob('job-fail', 'claude', 'p', '/cwd')).rejects.toThrow(
        'pm2 start failed: pm2 error'
      );
    });

    it('throws when the command string is empty', async () => {
      execMock.mockResolvedValue(makeExecResult(0, '[]'));
      await expect(startJob('job-empty', '   ', 'p', '/cwd')).rejects.toThrow(/empty command/);
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

    it('keeps quoted args together when tokenizing', async () => {
      execMock.mockResolvedValue(makeExecResult(0, '[]'));

      await startJob('job-q', 'claude --param "hello world" --flag', 'p', '/cwd');

      const args = (execMock.mock.calls.find(
        (c: unknown[]) => c[0] === 'pm2' && Array.isArray(c[1]) && c[1][0] === 'start'
      )![1]) as string[];
      const runnerArgv = args.slice(args.indexOf('--') + 1);
      // job-id, log, prompt, then the tokenized command.
      expect(runnerArgv.slice(3)).toEqual(['claude', '--param', 'hello world', '--flag']);
    });
  });

  describe('splitCommand', () => {
    it('splits on whitespace', async () => {
      const { splitCommand } = await import('@/lib/pm2-jobs');
      expect(splitCommand('claude --model opus --print')).toEqual(['claude', '--model', 'opus', '--print']);
    });

    it('preserves double-quoted segments', async () => {
      const { splitCommand } = await import('@/lib/pm2-jobs');
      expect(splitCommand('claude --param "hello world"')).toEqual(['claude', '--param', 'hello world']);
    });

    it('preserves single-quoted segments', async () => {
      const { splitCommand } = await import('@/lib/pm2-jobs');
      expect(splitCommand("claude --param 'spaced value'")).toEqual(['claude', '--param', 'spaced value']);
    });

    it('handles backslash escapes inside quotes', async () => {
      const { splitCommand } = await import('@/lib/pm2-jobs');
      expect(splitCommand('claude --x "a\\"b"')).toEqual(['claude', '--x', 'a"b']);
    });

    it('returns empty array for empty / whitespace-only input', async () => {
      const { splitCommand } = await import('@/lib/pm2-jobs');
      expect(splitCommand('')).toEqual([]);
      expect(splitCommand('   ')).toEqual([]);
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
