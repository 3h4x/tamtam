import { mkdtemp, writeFile, chmod, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { describe, it, expect, afterEach } from 'vitest';

const tempDirs: string[] = [];

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end('Review the diff');
  });
}

async function waitForFile(path: string, timeoutMs = 1000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe('codex-shim', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('emits assistant text once and preserves the Codex session id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    const sessionId = '019de76e-0ffe-7e43-9335-60c482aac2ea';
    await writeFile(fakeCodex, `#!/usr/bin/env node
const events = [
  { type: 'session_meta', payload: { id: '${sessionId}' } },
  { type: 'event_msg', payload: { type: 'agent_message', message: 'NEEDS ATTENTION', phase: 'final_answer' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'NEEDS ATTENTION' }] } },
  { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 12, output_tokens: 3, cached_input_tokens: 4 } } } },
  { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'NEEDS ATTENTION' } },
];
for (const event of events) console.log(JSON.stringify(event));
`);
    await chmod(fakeCodex, 0o755);

    const result = await runNode([
      'scripts/codex-shim.js',
      '--output-format',
      'stream-json',
      '--model',
      'sonnet',
      '--permission-mode',
      'bypassPermissions',
    ], {
      ...process.env,
      CODEX_BIN: fakeCodex,
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const text = lines
      .filter((line) => line.type === 'stream_event' && line.event?.type === 'content_block_delta')
      .map((line) => line.event.delta.text)
      .join('');
    const final = lines.find((line) => line.type === 'result');

    expect(text).toBe('NEEDS ATTENTION');
    expect(final.session_id).toBe(sessionId);
    expect(final.modelUsage['gpt-5.5']).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadInputTokens: 4,
    });
  });

  it('emits assistant response_item text without echoing prompt messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    await writeFile(fakeCodex, `#!/usr/bin/env node
const events = [
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'DO NOT ECHO' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Verdict: LGTM' }] } },
  { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } } } },
];
for (const event of events) console.log(JSON.stringify(event));
`);
    await chmod(fakeCodex, 0o755);

    const result = await runNode([
      'scripts/codex-shim.js',
      '--output-format',
      'stream-json',
      '--model',
      'sonnet',
    ], {
      ...process.env,
      CODEX_BIN: fakeCodex,
    });

    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const text = lines
      .filter((line) => line.type === 'stream_event' && line.event?.type === 'content_block_delta')
      .map((line) => line.event.delta.text)
      .join('');
    const final = lines.find((line) => line.type === 'result');

    expect(text).toBe('Verdict: LGTM');
    expect(text).not.toContain('DO NOT ECHO');
    expect(final.is_error).toBe(false);
  });

  it('parses real Codex item.completed agent_message events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    const sessionId = '019de81b-075a-7410-a6eb-0031655a589f';
    await writeFile(fakeCodex, `#!/usr/bin/env node
const events = [
  { type: 'thread.started', thread_id: '${sessionId}' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Verdict: LGTM' } },
  { type: 'turn.completed', usage: { input_tokens: 12489, cached_input_tokens: 10112, output_tokens: 20, reasoning_output_tokens: 13 } },
];
for (const event of events) console.log(JSON.stringify(event));
`);
    await chmod(fakeCodex, 0o755);

    const result = await runNode([
      'scripts/codex-shim.js',
      '--output-format',
      'stream-json',
      '--model',
      'sonnet',
    ], {
      ...process.env,
      CODEX_BIN: fakeCodex,
    });

    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const text = lines
      .filter((line) => line.type === 'stream_event' && line.event?.type === 'content_block_delta')
      .map((line) => line.event.delta.text)
      .join('');
    const final = lines.find((line) => line.type === 'result');

    expect(text).toBe('Verdict: LGTM');
    expect(final.session_id).toBe(sessionId);
    expect(final.is_error).toBe(false);
    expect(final.modelUsage['gpt-5.5']).toMatchObject({
      inputTokens: 12489,
      outputTokens: 20,
      cacheReadInputTokens: 10112,
    });
  });

  it('fails stream-json runs that produce no assistant output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    await writeFile(fakeCodex, `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 0 } } } }));
`);
    await chmod(fakeCodex, 0o755);

    const result = await runNode([
      'scripts/codex-shim.js',
      '--output-format',
      'stream-json',
      '--model',
      'sonnet',
    ], {
      ...process.env,
      CODEX_BIN: fakeCodex,
    });

    expect(result.code).toBe(1);
    const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const final = lines.find((line) => line.type === 'result');

    expect(final.is_error).toBe(true);
    expect(final.result).toBe('[codex-shim] codex produced no assistant output');
  });

  it('forwards termination signals to the Codex child process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    const readyFile = join(dir, 'ready');
    const signalFile = join(dir, 'signal');
    const pidFile = join(dir, 'pid');
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(signalFile)}, 'SIGTERM');
  process.exit(143);
});
setInterval(() => {}, 1000);
`);
    await chmod(fakeCodex, 0o755);

    const proc = spawn(process.execPath, [
      'scripts/codex-shim.js',
      '--output-format',
      'stream-json',
      '--model',
      'sonnet',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_BIN: fakeCodex },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdin.end('Review the diff');

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
        const childPid = Number(await readFile(pidFile, 'utf8'));
        if (Number.isFinite(childPid)) process.kill(childPid, 'SIGKILL');
      } catch {
        // The child should already be gone.
      }
    }
  });
});
