import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const RUNNER = resolve(__dirname, '..', '..', 'scripts', 'job-runner.js');

function runRunner(args: string[]): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; child: ReturnType<typeof spawn> }> {
  return new Promise((res) => {
    const child = spawn('node', [RUNNER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('exit', (code, signal) => res({ exitCode: code, signal, child }));
  });
}

describe('scripts/job-runner.js', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'job-runner-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('logs launch + exit breadcrumbs and propagates the child exit code', async () => {
    const logPath = join(dir, 'a.log');
    const promptPath = join(dir, 'a.prompt');
    writeFileSync(promptPath, 'hello');

    const { exitCode } = await runRunner([
      'job-a', logPath, promptPath,
      'bash', '-c', 'cat; echo done; exit 7',
    ]);

    expect(exitCode).toBe(7);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('[tamtam] launching:');
    expect(log).toContain('hello');   // prompt was piped to stdin → echoed by `cat`
    expect(log).toContain('done');    // child stdout
    expect(log).toContain('[tamtam] exited with code 7');
  });

  it('exits 127 when the command binary does not exist', async () => {
    const logPath = join(dir, 'b.log');
    const promptPath = join(dir, 'b.prompt');
    writeFileSync(promptPath, '');

    const { exitCode } = await runRunner([
      'job-b', logPath, promptPath,
      '/no/such/binary-' + Date.now(),
    ]);

    expect(exitCode).toBe(127);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toMatch(/\[tamtam\] (spawn (failed|error)):/);
  });

  it('forwards SIGTERM to the child so it actually dies (orphan fix)', async () => {
    const logPath = join(dir, 'c.log');
    const promptPath = join(dir, 'c.prompt');
    writeFileSync(promptPath, '');

    // Child catches SIGTERM, exits 143 (the convention: 128 + signal#).
    const childCode = `
      process.on('SIGTERM', () => process.exit(143));
      console.log('ready');
      setInterval(() => {}, 1000);
    `;

    const child = spawn('node', [RUNNER,
      'job-c', logPath, promptPath,
      'node', '-e', childCode,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    // Wait until the inner child has installed its handler.
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('child never said ready')), 5000);
      const onData = () => {
        let log = '';
        try { log = readFileSync(logPath, 'utf-8'); } catch { return; }
        if (log.includes('ready')) { clearTimeout(t); clearInterval(poll); res(); }
      };
      const poll = setInterval(onData, 50);
    });

    const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));
    child.kill('SIGTERM');
    const code = await exited;

    // The runner forwarded SIGTERM, the child exited 143, the runner
    // propagates that exit code. If signal-forwarding were broken, the inner
    // node child would survive past the runner's exit (the orphan we're
    // fixing) and the test would either hang or report a different code.
    expect(code).toBe(143);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('[tamtam] exited with code 143');
  });

  it('refuses to start with too few args', async () => {
    const { exitCode } = await runRunner(['only-jobid']);
    expect(exitCode).toBe(2);
  });
});
