import { createRequire } from 'module';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { describe, it, expect, afterEach, vi } from 'vitest';

const _require = createRequire(import.meta.url);
const shim = _require(join(process.cwd(), 'scripts/claude-shim.js')) as {
  resolveClaudeModel: (value: string, env?: Partial<NodeJS.ProcessEnv>) => string;
  transformArgs: (argv: string[], env?: Partial<NodeJS.ProcessEnv>) => string[];
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function waitForFile(path: string, timeoutMs = 10_000): Promise<string> {
  let content = '';
  await vi.waitFor(async () => {
    content = await readFile(path, 'utf8');
  }, { timeout: timeoutMs, interval: 5 });
  return content;
}

describe('claude-shim model resolution', () => {
  it('translates fast → haiku (default)', () => {
    expect(shim.resolveClaudeModel('fast', {})).toBe('haiku');
  });

  it('translates normal → sonnet (default)', () => {
    expect(shim.resolveClaudeModel('normal', {})).toBe('sonnet');
  });

  it('translates smart → opus (default)', () => {
    expect(shim.resolveClaudeModel('smart', {})).toBe('opus');
  });

  it('respects CLAUDE_FAST_MODEL env override', () => {
    expect(shim.resolveClaudeModel('fast', { CLAUDE_FAST_MODEL: 'claude-haiku-4-5' })).toBe('claude-haiku-4-5');
  });

  it('respects CLAUDE_NORMAL_MODEL env override', () => {
    expect(shim.resolveClaudeModel('normal', { CLAUDE_NORMAL_MODEL: 'claude-sonnet-4-6' })).toBe('claude-sonnet-4-6');
  });

  it('passes through an already-resolved model ID unchanged', () => {
    expect(shim.resolveClaudeModel('claude-opus-4-7', {})).toBe('claude-opus-4-7');
  });

  it('handles --model=<value> equals-form', () => {
    const args = shim.transformArgs(['--model=fast'], {});
    expect(args).toContain('--model=haiku');
  });

  it('translates --fallback-model tier names', () => {
    const args = shim.transformArgs(['--model', 'normal', '--fallback-model', 'fast'], {});
    const idx = args.indexOf('--fallback-model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('haiku');
  });

  it('handles --fallback-model=<value> equals-form', () => {
    const args = shim.transformArgs(['--fallback-model=smart'], {});
    expect(args).toContain('--fallback-model=opus');
  });

  it('passes through unrelated args verbatim', () => {
    const args = shim.transformArgs(['--print', '--output-format', 'stream-json', '--model', 'fast'], {});
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
  });
});

describe('claude-shim broker MCP injection', () => {
  it('injects --mcp-config, --strict-mcp-config, and broker allowedTools when TAMTAM_MCP_CONFIG_PATH is set', () => {
    const args = shim.transformArgs(['--print'], { TAMTAM_MCP_CONFIG_PATH: '/tmp/run/mcp.json' });
    expect(args).toContain('--mcp-config');
    expect(args).toContain('/tmp/run/mcp.json');
    // Strict mode keeps the user's global/plugin MCP servers (e.g. the headed
    // playwright plugin) out of the headless agent run.
    expect(args).toContain('--strict-mcp-config');
    const i = args.indexOf('--allowedTools');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('mcp__tamtam_browser');
  });

  it('adds nothing when TAMTAM_MCP_CONFIG_PATH is unset', () => {
    const args = shim.transformArgs(['--print'], {});
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--strict-mcp-config');
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
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(signalFile)}, 'SIGTERM');
  process.exit(143);
});
fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
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

    await waitForFile(readyFile);

    const closePromise = new Promise<number | null>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', resolve);
    });
    proc.kill('SIGTERM');

    const code = await closePromise;

    try {
      expect(await waitForFile(signalFile)).toBe('SIGTERM');
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
