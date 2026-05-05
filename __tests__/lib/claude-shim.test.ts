import { mkdtemp, writeFile, chmod, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { describe, it, expect, afterEach } from 'vitest';

const tempDirs: string[] = [];

async function runShim(
  dir: string,
  shimArgs: string[],
  env: Partial<NodeJS.ProcessEnv> = {},
): Promise<{ code: number | null; argsWritten: string[] }> {
  const argsFile = join(dir, 'args.json');

  // Fake claude binary: write received args to a JSON file then exit 0.
  const fakeClaude = join(dir, 'claude');
  await writeFile(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
`,
  );
  await chmod(fakeClaude, 0o755);

  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ['scripts/claude-shim.js', ...shimArgs],
      {
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_BIN: fakeClaude, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    proc.stdin.end('');
    proc.on('error', reject);
    proc.on('close', async (code) => {
      let argsWritten: string[] = [];
      try {
        argsWritten = JSON.parse(await readFile(argsFile, 'utf8'));
      } catch {
        // Binary may not have been reached if shim errored before exec.
      }
      resolve({ code, argsWritten });
    });
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('claude-shim model resolution', () => {
  it('translates fast → haiku (default)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-claude-shim-'));
    tempDirs.push(dir);
    const { argsWritten } = await runShim(dir, ['--model', 'fast']);
    const idx = argsWritten.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argsWritten[idx + 1]).toBe('haiku');
  });

  it('translates normal → sonnet (default)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-claude-shim-'));
    tempDirs.push(dir);
    const { argsWritten } = await runShim(dir, ['--model', 'normal']);
    const idx = argsWritten.indexOf('--model');
    expect(argsWritten[idx + 1]).toBe('sonnet');
  });

  it('translates smart → opus (default)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-claude-shim-'));
    tempDirs.push(dir);
    const { argsWritten } = await runShim(dir, ['--model', 'smart']);
    const idx = argsWritten.indexOf('--model');
    expect(argsWritten[idx + 1]).toBe('opus');
  });

  it('respects CLAUDE_FAST_MODEL env override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-claude-shim-'));
    tempDirs.push(dir);
    const { argsWritten } = await runShim(dir, ['--model', 'fast'], {
      CLAUDE_FAST_MODEL: 'claude-haiku-4-5',
    });
    const idx = argsWritten.indexOf('--model');
    expect(argsWritten[idx + 1]).toBe('claude-haiku-4-5');
  });

  it('respects CLAUDE_NORMAL_MODEL env override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-claude-shim-'));
    tempDirs.push(dir);
    const { argsWritten } = await runShim(dir, ['--model', 'normal'], {
      CLAUDE_NORMAL_MODEL: 'claude-sonnet-4-6',
    });
    const idx = argsWritten.indexOf('--model');
    expect(argsWritten[idx + 1]).toBe('claude-sonnet-4-6');
  });

  it('passes through an already-resolved model ID unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-claude-shim-'));
    tempDirs.push(dir);
    const { argsWritten } = await runShim(dir, ['--model', 'claude-opus-4-7']);
    const idx = argsWritten.indexOf('--model');
    expect(argsWritten[idx + 1]).toBe('claude-opus-4-7');
  });

  it('handles --model=<value> equals-form', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-claude-shim-'));
    tempDirs.push(dir);
    const { argsWritten } = await runShim(dir, ['--model=fast']);
    expect(argsWritten).toContain('--model=haiku');
  });

  it('translates --fallback-model tier names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-claude-shim-'));
    tempDirs.push(dir);
    const { argsWritten } = await runShim(dir, ['--model', 'normal', '--fallback-model', 'fast']);
    const idx = argsWritten.indexOf('--fallback-model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argsWritten[idx + 1]).toBe('haiku');
  });

  it('handles --fallback-model=<value> equals-form', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-claude-shim-'));
    tempDirs.push(dir);
    const { argsWritten } = await runShim(dir, ['--fallback-model=smart']);
    expect(argsWritten).toContain('--fallback-model=opus');
  });

  it('passes through unrelated args verbatim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-claude-shim-'));
    tempDirs.push(dir);
    const { argsWritten } = await runShim(dir, [
      '--print',
      '--output-format',
      'stream-json',
      '--model',
      'fast',
    ]);
    expect(argsWritten).toContain('--print');
    expect(argsWritten).toContain('--output-format');
    expect(argsWritten).toContain('stream-json');
  });
});

describe('claude-shim signal forwarding', () => {
  it('forwards SIGTERM to the child process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-claude-shim-sig-'));
    tempDirs.push(dir);
    const readyFile = join(dir, 'ready');
    const signalFile = join(dir, 'signal');
    const pidFile = join(dir, 'pid');

    const fakeClaude = join(dir, 'claude');
    await writeFile(
      fakeClaude,
      `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(signalFile)}, 'SIGTERM');
  process.exit(143);
});
setInterval(() => {}, 1000);
`,
    );
    await chmod(fakeClaude, 0o755);

    const proc = spawn(
      process.execPath,
      ['scripts/claude-shim.js', '--model', 'normal'],
      {
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_BIN: fakeClaude },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    proc.stdin.end('');

    // Wait until the fake claude is running.
    const startedAt = Date.now();
    while (Date.now() - startedAt < 2000) {
      try {
        await readFile(readyFile, 'utf8');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    const closePromise = new Promise<number | null>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', resolve);
    });
    proc.kill('SIGTERM');

    const code = await closePromise;

    try {
      const sig = await readFile(signalFile, 'utf8');
      expect(sig).toBe('SIGTERM');
      expect(code).toBe(143);
    } finally {
      try {
        const childPid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
        if (Number.isFinite(childPid) && childPid > 0) process.kill(childPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });
});
