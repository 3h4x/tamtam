import { createRequire } from 'module';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { describe, it, expect, afterEach } from 'vitest';

const _require = createRequire(import.meta.url);
const shim = _require(join(process.cwd(), 'scripts/codex-shim.js')) as {
  resolveModel: (model: string, env?: Partial<NodeJS.ProcessEnv>) => string;
  permissionArgsFor: (mode: string) => string[];
  sandboxFor: (mode: string) => string;
  approvalFor: (mode: string) => string;
};

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

  it('maps bypassPermissions to Codex full approval and sandbox bypass', () => {
    const args = shim.permissionArgsFor('bypassPermissions');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('-a');
  });

  it('maps plan to read-only sandbox with on-request approval', () => {
    const args = shim.permissionArgsFor('plan');
    expect(args).toEqual(['-a', 'on-request', '--sandbox', 'read-only']);
  });

  it('maps dontAsk to workspace-write sandbox without approval prompts', () => {
    const args = shim.permissionArgsFor('dontAsk');
    expect(args).toEqual(['-a', 'never', '--sandbox', 'workspace-write']);
  });

  it('resolves semantic tiers through the new env vars', () => {
    expect(shim.resolveModel('smart', { CODEX_SMART_MODEL: 'gpt-test-smart' })).toBe('gpt-test-smart');
  });

  it('keeps honoring legacy env var aliases', () => {
    expect(shim.resolveModel('haiku', { CODEX_HAIKU_MODEL: 'gpt-test-fast' })).toBe('gpt-test-fast');
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
    expect(final.modelUsage['gpt-5.4']).toMatchObject({
      inputTokens: 8,
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
    expect(final.modelUsage['gpt-5.4']).toMatchObject({
      inputTokens: 2377,
      outputTokens: 20,
      cacheReadInputTokens: 10112,
    });
  });

  it('reports Codex cached input separately instead of double-counting it as full-price input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    await writeFile(fakeCodex, `#!/usr/bin/env node
const events = [
  { type: 'thread.started', thread_id: 'sess-cache' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
  { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } },
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
    const final = lines.find((line) => line.type === 'result');

    expect(final.modelUsage['gpt-5.4']).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 900,
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

  it('passes through plain JSON assistant output in text mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    await writeFile(fakeCodex, `#!/usr/bin/env node
console.log(JSON.stringify({ results: [{ index: 1, text: 'criterion', verified: true }] }));
`);
    await chmod(fakeCodex, 0o755);

    const result = await runNode([
      'scripts/codex-shim.js',
      '--model',
      'sonnet',
    ], {
      ...process.env,
      CODEX_BIN: fakeCodex,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      results: [{ index: 1, text: 'criterion', verified: true }],
    });
  });

  it('passes through JSON assistant output with protocol-looking keys in text mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    await writeFile(fakeCodex, `#!/usr/bin/env node
console.log(JSON.stringify({
  type: 'verification_report',
  payload: { status: 'LGTM', item: { type: 'check', verified: true } },
  usage: { notes: 'assistant output, not Codex telemetry' },
}));
`);
    await chmod(fakeCodex, 0o755);

    const result = await runNode([
      'scripts/codex-shim.js',
      '--model',
      'sonnet',
    ], {
      ...process.env,
      CODEX_BIN: fakeCodex,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      type: 'verification_report',
      payload: { status: 'LGTM', item: { type: 'check', verified: true } },
      usage: { notes: 'assistant output, not Codex telemetry' },
    });
  });

  it('emits a useful error when Codex exits non-zero without stderr', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    await writeFile(fakeCodex, `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'working on it' } }));
process.exit(1);
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
    expect(final.result).toContain('codex exited 1 after assistant output with no stderr');
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

    await waitForFile(readyFile, 10_000);
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

  it('retries once when codex exits 1 with no stderr after streaming output (transient crash)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    const attemptFile = join(dir, 'attempt');
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('fs');
const path = ${JSON.stringify(attemptFile)};
let attempt = 0;
try { attempt = parseInt(fs.readFileSync(path, 'utf8'), 10) || 0; } catch {}
fs.writeFileSync(path, String(attempt + 1));
if (attempt === 0) {
  console.log(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] } }));
  console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 3, output_tokens: 1, cached_input_tokens: 2 } } } }));
  process.exit(1);
}
console.log(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recovered' }] } }));
console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 2, cached_input_tokens: 1 } } } }));
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

    expect(parseInt(await readFile(attemptFile, 'utf8'), 10)).toBe(2);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const finals = lines.filter((l) => l.type === 'result');
    expect(finals).toHaveLength(1);
    expect(finals[0].is_error).toBe(false);
    expect(finals[0].modelUsage['gpt-5.4']).toMatchObject({
      inputTokens: 5,
      outputTokens: 3,
      cacheReadInputTokens: 3,
    });
    const text = lines
      .filter((l) => l.type === 'stream_event' && l.event?.type === 'content_block_delta')
      .map((l) => l.event.delta.text)
      .join('');
    expect(text).toContain('partial');
    expect(text).toContain('retrying once');
    expect(text).toContain('recovered');
    expect(finals[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('does not retry when codex exits 1 with stderr (real failure)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    const attemptFile = join(dir, 'attempt');
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('fs');
const path = ${JSON.stringify(attemptFile)};
let attempt = 0;
try { attempt = parseInt(fs.readFileSync(path, 'utf8'), 10) || 0; } catch {}
fs.writeFileSync(path, String(attempt + 1));
console.log(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'oops' }] } }));
process.stderr.write('apply_patch verification failed\\n');
process.exit(1);
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

    expect(parseInt(await readFile(attemptFile, 'utf8'), 10)).toBe(1);
    const lines = result.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const final = lines.find((l) => l.type === 'result');
    expect(final.is_error).toBe(true);
    expect(final.result).toContain('apply_patch verification failed');
  });

  it('does not duplicate an already-streamed prefix when the retry restarts the answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    const attemptFile = join(dir, 'attempt');
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('fs');
const path = ${JSON.stringify(attemptFile)};
let attempt = 0;
try { attempt = parseInt(fs.readFileSync(path, 'utf8'), 10) || 0; } catch {}
fs.writeFileSync(path, String(attempt + 1));
if (attempt === 0) {
  console.log(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] } }));
  process.exit(1);
}
console.log(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] } }));
console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 7, output_tokens: 2 } } } }));
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

    expect(parseInt(await readFile(attemptFile, 'utf8'), 10)).toBe(2);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const text = lines
      .filter((l) => l.type === 'stream_event' && l.event?.type === 'content_block_delta')
      .map((l) => l.event.delta.text)
      .join('');
    expect(text).toContain('Hello');
    expect(text).toContain('retrying once');
    expect(text).toContain(' world');
    expect(text.match(/Hello/g)?.length).toBe(1);
    expect(text).not.toContain('HelloHello');
  });

  it('exits 0 when the retry cleanly replays the exact same answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-codex-shim-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, 'codex');
    const attemptFile = join(dir, 'attempt');
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('fs');
const path = ${JSON.stringify(attemptFile)};
let attempt = 0;
try { attempt = parseInt(fs.readFileSync(path, 'utf8'), 10) || 0; } catch {}
fs.writeFileSync(path, String(attempt + 1));
console.log(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] } }));
if (attempt === 0) {
  process.exit(1);
}
console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 1 } } } }));
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

    expect(parseInt(await readFile(attemptFile, 'utf8'), 10)).toBe(2);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const finals = lines.filter((l) => l.type === 'result');
    expect(finals).toHaveLength(1);
    expect(finals[0].is_error).toBe(false);
    const text = lines
      .filter((l) => l.type === 'stream_event' && l.event?.type === 'content_block_delta')
      .map((l) => l.event.delta.text)
      .join('');
    expect(text).toContain('Hello');
    expect(text).toContain('retrying once');
    expect(text.match(/Hello/g)?.length).toBe(1);
  });
});
