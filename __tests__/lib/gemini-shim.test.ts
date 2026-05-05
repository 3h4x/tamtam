import { mkdtemp, writeFile, chmod, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { describe, it, expect, afterEach } from 'vitest';

const tempDirs: string[] = [];

async function makeArgsBin(dir: string): Promise<void> {
  const argsFile = join(dir, 'args.json');
  const bin = join(dir, 'gemini');
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
`,
  );
  await chmod(bin, 0o755);
}

async function makeStreamBin(dir: string, events: object[]): Promise<void> {
  const bin = join(dir, 'gemini');
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  await writeFile(
    bin,
    `#!/usr/bin/env node
const lines = ${JSON.stringify(lines)};
console.log(lines);
`,
  );
  await chmod(bin, 0o755);
}

function runShim(
  dir: string,
  shimArgs: string[],
  env: Partial<NodeJS.ProcessEnv> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['scripts/gemini-shim.js', ...shimArgs], {
      cwd: process.cwd(),
      env: { ...process.env, GEMINI_BIN: join(dir, 'gemini'), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.stdin.end('test prompt');
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function readArgs(dir: string): Promise<string[]> {
  return JSON.parse(await readFile(join(dir, 'args.json'), 'utf8'));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('gemini-shim model resolution', () => {
  it('translates fast → flash (default)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--model', 'fast']);
    const args = await readArgs(dir);
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('flash');
  });

  it('translates normal → pro (default)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--model', 'normal']);
    const args = await readArgs(dir);
    expect(args[args.indexOf('--model') + 1]).toBe('pro');
  });

  it('translates smart → pro (default)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--model', 'smart']);
    const args = await readArgs(dir);
    expect(args[args.indexOf('--model') + 1]).toBe('pro');
  });

  it('translates thinking → thinking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--model', 'thinking']);
    const args = await readArgs(dir);
    expect(args[args.indexOf('--model') + 1]).toBe('thinking');
  });

  it('respects GEMINI_FAST_MODEL env override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--model', 'fast'], { GEMINI_FAST_MODEL: 'gemini-2.5-flash' });
    const args = await readArgs(dir);
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-2.5-flash');
  });

  it('respects GEMINI_HAIKU_MODEL legacy alias for fast tier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--model', 'haiku'], { GEMINI_HAIKU_MODEL: 'gemini-test-haiku' });
    const args = await readArgs(dir);
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-test-haiku');
  });

  it('falls back to GEMINI_MODEL for unknown tier names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--model', 'someunknown'], { GEMINI_MODEL: 'gemini-custom' });
    const args = await readArgs(dir);
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-custom');
  });

  it('passes an already-resolved model ID through unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--model', 'gemini-1.5-pro-002']);
    const args = await readArgs(dir);
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-1.5-pro-002');
  });

  it('handles --model=<value> equals-form', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--model=fast']);
    const args = await readArgs(dir);
    expect(args[args.indexOf('--model') + 1]).toBe('flash');
  });
});

describe('gemini-shim approval mode mapping', () => {
  it('maps bypassPermissions → yolo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--permission-mode', 'bypassPermissions']);
    const args = await readArgs(dir);
    const idx = args.indexOf('--approval-mode');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('yolo');
  });

  it('maps auto → auto_edit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--permission-mode', 'auto']);
    const args = await readArgs(dir);
    expect(args[args.indexOf('--approval-mode') + 1]).toBe('auto_edit');
  });

  it('maps plan → plan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--permission-mode', 'plan']);
    const args = await readArgs(dir);
    expect(args[args.indexOf('--approval-mode') + 1]).toBe('plan');
  });

  it('maps default → default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--permission-mode=default']);
    const args = await readArgs(dir);
    expect(args[args.indexOf('--approval-mode') + 1]).toBe('default');
  });

  it('consumes --output-format and does not forward it to gemini', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeArgsBin(dir);
    await runShim(dir, ['--output-format', 'stream-json', '--model', 'fast']);
    const args = await readArgs(dir);
    // gemini gets its own --output-format stream-json, but the one passed
    // in by the caller should not appear a second time
    const formatIndices = args.reduce<number[]>((acc, a, i) => (a === '--output-format' ? [...acc, i] : acc), []);
    expect(formatIndices).toHaveLength(1);
    expect(args[formatIndices[0] + 1]).toBe('stream-json');
  });
});

describe('gemini-shim stream translation', () => {
  it('translates assistant message to text_delta events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeStreamBin(dir, [
      { type: 'message', role: 'assistant', content: 'Hello world' },
      { type: 'result', status: 'success', model: 'gemini-1.5-pro', stats: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const { stdout } = await runShim(dir, ['--model', 'fast', '--output-format', 'stream-json']);
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const text = lines
      .filter((l) => l.type === 'stream_event' && l.event?.type === 'content_block_delta')
      .map((l) => l.event.delta.text)
      .join('');
    expect(text).toBe('Hello world');
    expect(lines.some((l) => l.type === 'stream_event' && l.event?.type === 'content_block_start')).toBe(true);
  });

  it('translates result event to Claude result format with modelUsage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeStreamBin(dir, [
      { type: 'message', role: 'assistant', content: 'Done' },
      { type: 'result', status: 'success', model: 'gemini-1.5-pro', stats: { input_tokens: 20, output_tokens: 8 } },
    ]);
    const { stdout } = await runShim(dir, ['--model', 'normal', '--output-format', 'stream-json']);
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const result = lines.find((l) => l.type === 'result');
    expect(result).toBeDefined();
    expect(result.is_error).toBe(false);
    const usage = result.modelUsage['gemini-1.5-pro'];
    expect(usage).toMatchObject({ inputTokens: 20, outputTokens: 8 });
  });

  it('emits content_block_stop after text block before tool_use', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeStreamBin(dir, [
      { type: 'message', role: 'assistant', content: 'Thinking...' },
      { type: 'tool_use', tool_name: 'bash', tool_id: 'tool-1', parameters: { cmd: 'ls' } },
      { type: 'result', status: 'success', model: 'gemini-1.5-pro', stats: {} },
    ]);
    const { stdout } = await runShim(dir, ['--model', 'fast', '--output-format', 'stream-json']);
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const stopBeforeTool = lines.findIndex(
      (l) => l.type === 'stream_event' && l.event?.type === 'content_block_stop',
    );
    const toolStart = lines.findIndex(
      (l) => l.type === 'stream_event' && l.event?.type === 'content_block_start' && l.event.content_block?.type === 'tool_use',
    );
    expect(stopBeforeTool).toBeGreaterThanOrEqual(0);
    expect(toolStart).toBeGreaterThan(stopBeforeTool);
  });

  it('emits error result when underlying gemini result has status error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tamtam-gemini-shim-'));
    tempDirs.push(dir);
    await makeStreamBin(dir, [
      { type: 'result', status: 'error', error: 'quota exceeded', model: 'gemini-1.5-pro', stats: {} },
    ]);
    const { stdout } = await runShim(dir, ['--model', 'fast', '--output-format', 'stream-json']);
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const result = lines.find((l) => l.type === 'result');
    expect(result?.is_error).toBe(true);
    expect(result?.result).toContain('quota exceeded');
  });
});
