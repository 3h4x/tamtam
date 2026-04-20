import { describe, it, expect } from 'vitest';
import { exec } from '@/lib/shell';

describe('exec — killProcessGroup mode', () => {
  it('runs a command and captures stdout', async () => {
    const r = await exec('echo', ['hello world'], { killProcessGroup: true });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello world');
    expect(r.stderr).toBe('');
  });

  it('captures stderr separately from stdout', async () => {
    // sh -c writes to both streams
    const r = await exec('sh', ['-c', 'echo out; echo err >&2'], { killProcessGroup: true });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('out');
    expect(r.stderr.trim()).toBe('err');
  });

  it('propagates non-zero exit code', async () => {
    const r = await exec('sh', ['-c', 'exit 42'], { killProcessGroup: true });
    expect(r.exitCode).toBe(42);
  });

  it('resolves with exitCode 1 when timeout fires', async () => {
    // sleep 10 would hang; with a 100ms timeout it should be killed
    const r = await exec('sleep', ['10'], { killProcessGroup: true, timeout: 100 });
    expect(r.exitCode).toBe(1);
  }, 3000);

  it('returns stderr output from a failing command', async () => {
    const r = await exec('sh', ['-c', 'echo boom >&2; exit 1'], { killProcessGroup: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.trim()).toBe('boom');
  });

  it('resolves with exitCode 1 on spawn error (bad command)', async () => {
    const r = await exec('__no_such_command__', [], { killProcessGroup: true });
    expect(r.exitCode).toBe(1);
  });
});

describe('exec — standard (execFile) mode', () => {
  it('runs a command and captures stdout', async () => {
    const r = await exec('echo', ['hello']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
  });

  it('propagates non-zero exit code', async () => {
    const r = await exec('sh', ['-c', 'exit 7']);
    expect(r.exitCode).toBe(7);
  });

  it('captures stderr', async () => {
    const r = await exec('sh', ['-c', 'echo err >&2; exit 1']);
    expect(r.stderr.trim()).toBe('err');
    expect(r.exitCode).toBe(1);
  });
});
