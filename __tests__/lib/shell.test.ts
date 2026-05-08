import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { exec } from '@/lib/shared/shell';

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

  it('returns exitCode as a number 1 for a non-existent command (not a string error code)', async () => {
    // When execFile encounters ENOENT, error.code is the string 'ENOENT'.
    // The previous implementation returned that string directly via `?? 1`.
    // The fixed implementation coerces with Number(), ensuring exitCode is always numeric.
    const r = await exec('__no_such_command__', []);
    expect(typeof r.exitCode).toBe('number');
    expect(r.exitCode).toBe(1);
  });
});

describe('exec — abortProcessTree mode', () => {
  it('kills descendant processes when an AbortSignal cancels the parent command', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tamtam-shell-'));
    const pidFile = join(tempDir, 'child.pid');
    const controller = new AbortController();
    const escapedPidFile = JSON.stringify(pidFile);
    const childCode = 'setInterval(() => {}, 1000)';
    const parentCode = [
      'const fs = require("fs");',
      'const { spawn } = require("child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" });`,
      `fs.writeFileSync(${escapedPidFile}, String(child.pid));`,
      'setInterval(() => {}, 1000);',
    ].join(' ');

    try {
      const execPromise = exec(process.execPath, ['-e', parentCode], {
        signal: controller.signal,
        abortProcessTree: true,
        timeout: 10_000,
      });

      const deadline = Date.now() + 5_000;
      let childPid = 0;
      while (Date.now() < deadline) {
        try {
          childPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
          if (childPid > 0) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(childPid).toBeGreaterThan(0);
      controller.abort();
      const result = await execPromise;
      expect(result.exitCode).toBe(130);

      const killDeadline = Date.now() + 5_000;
      let alive = true;
      while (Date.now() < killDeadline) {
        try {
          process.kill(childPid, 0);
        } catch {
          alive = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(alive).toBe(false);
    } finally {
      try {
        const childPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
        if (childPid > 0) {
          try { process.kill(childPid, 'SIGKILL'); } catch {}
        }
      } catch {}
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});
